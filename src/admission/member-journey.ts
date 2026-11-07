import { CSRF_HEADER } from '../../shared/browser-contract';
import type { PublicCode, StatusResponse, VerificationState } from '../../shared/browser-contract';
import { digestToken, randomToken } from '../crypto/canonical-encoding';
import {
  deriveToken,
  issueCapability,
  verifyCapability,
  verifyDerivedToken,
} from '../crypto/capability-tokens';
import { createPkcePair } from '../crypto/pkce';
import type { VerificationCoordinator } from '../coordinator/verification-coordinator';
import type { AppConfig } from '../deployment-config';
import { MAX_BROWSER_BODY_BYTES, parseJson, readBoundedBody } from '../http/bounded-body';
import { BROWSER_COOKIE_NAME, buildBrowserCookie, readCookie } from '../http/browser-cookie';
import { hasExactOrigin, hasJsonContentType } from '../http/request-guards';
import { errorResponse, jsonResponse, redirectResponse } from '../http/secure-responses';
import type { AttemptStatus } from '../ledger/session-ledger';
import { record } from '../providers/discord-fields';
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchIdentity,
  parseCallback,
  revokeToken,
} from '../providers/discord-oauth';
import type { OAuthClient } from '../providers/discord-oauth';
import {
  TURNSTILE_ACTION,
  isPlausibleChallengeToken,
  verifyChallenge,
} from '../providers/turnstile-siteverify';

export type JourneyContext = {
  readonly config: AppConfig;
  readonly signingKey: CryptoKey;
  readonly coordinator: DurableObjectStub<VerificationCoordinator>;
  readonly execution: ExecutionContext;
};

type BrowserSession = {
  readonly handle: string;
  readonly expirySeconds: number;
  readonly digest: string;
};

const RESTART_HINT =
  'press "Verify" in Discord to get a new link and finish it in the same browser.';

const STATE_MESSAGES: Readonly<Record<VerificationState, string>> = {
  awaiting_oauth: 'Sign in with the Discord account you use on this server.',
  awaiting_challenge: 'Your account is confirmed, one browser check is left.',
  validating: 'This takes a few seconds.',
  grant_queued: 'You passed, your role is being added, this can take a moment.',
  verified: 'Your role is added, you can close this page and go back to Discord.',
  blocked:
    "This verification can't continue, if you think that's a mistake, contact staff through 'Help' below.",
  expired: `This verification has expired, ${RESTART_HINT}`,
  cancelled: `This verification was cancelled, ${RESTART_HINT}`,
};

const CODE_MESSAGES: Partial<Readonly<Record<PublicCode, string>>> = {
  wrong_account: "That's a different Discord account, sign in with the one you use on this server.",
  oauth_denied: 'Discord sign-in was cancelled, you can try again.',
  oauth_failed: "Discord sign-in didn't finish, you can try again.",
  challenge_failed: "The browser check didn't pass, you can try again.",
  challenge_unavailable: "The browser check isn't available right now, try again in a moment.",
  rate_limited: 'Too many attempts.',
};

function capabilityOptions(context: JourneyContext) {
  return { key: context.signingKey, context: context.config };
}

function restartResponse(status: number): Response {
  return errorResponse(status, {
    code: 'restart_required',
    message: `This verification is no longer active, ${RESTART_HINT}`,
  });
}

function invalidRequestResponse(): Response {
  return errorResponse(400, { code: 'invalid_request', message: "The request wasn't valid." });
}

function forbiddenResponse(): Response {
  return errorResponse(403, { code: 'forbidden', message: "This request wasn't allowed." });
}

function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

// fabricated/tampered cookies are rejected here, before any durable object call
async function authenticateBrowser(
  request: Request,
  context: JourneyContext,
): Promise<BrowserSession | null> {
  const cookie = readCookie(request, BROWSER_COOKIE_NAME);
  if (cookie.kind !== 'value') return null;

  const verified = await verifyCapability({
    ...capabilityOptions(context),
    purpose: 'browser',
    envelope: cookie.value,
    nowMs: Date.now(),
  });
  if (!verified.ok) return null;

  const { handle, expirySeconds } = verified.capability;
  return { handle, expirySeconds, digest: await digestToken(handle) };
}

async function hasValidCsrf(
  request: Request,
  context: JourneyContext,
  browser: BrowserSession,
): Promise<boolean> {
  const token = request.headers.get(CSRF_HEADER);
  if (token === null) return false;
  return verifyDerivedToken({
    ...capabilityOptions(context),
    purpose: 'csrf',
    handle: browser.handle,
    expirySeconds: browser.expirySeconds,
    token,
  });
}

async function buildStatus(
  context: JourneyContext,
  browser: Pick<BrowserSession, 'handle' | 'expirySeconds'>,
  status: AttemptStatus,
): Promise<StatusResponse> {
  const { handle, expirySeconds } = browser;
  const tokenOptions = { ...capabilityOptions(context), handle, expirySeconds };
  const message =
    (status.code === null ? undefined : CODE_MESSAGES[status.code]) ?? STATE_MESSAGES[status.state];

  return {
    state: status.state,
    message,
    expiresAt: new Date(status.expiresAtMs).toISOString(),
    csrfToken: await deriveToken({ ...tokenOptions, purpose: 'csrf' }),
    ...(status.code === null ? {} : { code: status.code }),
    ...(status.state === 'awaiting_challenge'
      ? {
          challenge: {
            siteKey: context.config.turnstileSiteKey,
            action: TURNSTILE_ACTION,
            cdata: await deriveToken({ ...tokenOptions, purpose: 'challenge' }),
          },
        }
      : {}),
  };
}

async function readJsonObject(request: Request): Promise<Readonly<Record<string, unknown>> | null> {
  const body = await readBoundedBody(request, MAX_BROWSER_BODY_BYTES);
  if (!body.ok) return null;
  const parsed = parseJson(body.bytes);
  return parsed.ok && record(parsed.value) ? parsed.value : null;
}

export async function handleEntryExchange(
  request: Request,
  context: JourneyContext,
): Promise<Response> {
  if (!hasExactOrigin(request, context.config.origin)) return forbiddenResponse();
  if (!hasJsonContentType(request)) return invalidRequestResponse();

  const body = await readJsonObject(request);
  const capability = body?.['capability'];
  if (typeof capability !== 'string') return invalidRequestResponse();

  const nowMs = Date.now();
  const entry = await verifyCapability({
    ...capabilityOptions(context),
    purpose: 'entry',
    envelope: capability,
    nowMs,
  });
  if (!entry.ok) return restartResponse(401);

  const existing = await authenticateBrowser(request, context);
  const browser = await issueCapability({
    ...capabilityOptions(context),
    purpose: 'browser',
    expirySeconds: entry.capability.expirySeconds,
  });
  const browserDigest = await digestToken(browser.handle);

  const exchanged = await context.coordinator.exchangeEntry({
    entryDigest: await digestToken(entry.capability.handle),
    browserDigest,
    existingBrowserDigest: existing?.digest ?? null,
  });

  switch (exchanged.kind) {
    case 'invalid':
      return restartResponse(410);
    case 'exhausted':
      return errorResponse(429, {
        code: 'restart_required',
        message: "This link can't be used again, press 'Verify' in Discord to get a new one.",
      });
    case 'reused':
    case 'created':
  }
  if (exchanged.status === null) return restartResponse(410);

  const activeBrowser = exchanged.kind === 'reused' && existing !== null ? existing : browser;
  const response = await buildStatus(context, activeBrowser, exchanged.status);
  if (exchanged.kind === 'reused') return jsonResponse(response);

  const maxAgeSeconds = Math.max(0, browser.expirySeconds - Math.floor(nowMs / 1000));
  return jsonResponse(response, 200, {
    'Set-Cookie': buildBrowserCookie(browser.envelope, maxAgeSeconds),
  });
}

export async function handleStatus(request: Request, context: JourneyContext): Promise<Response> {
  const browser = await authenticateBrowser(request, context);
  if (browser === null) return restartResponse(401);

  const status = await context.coordinator.readStatus(browser.digest);
  if (status === null) return restartResponse(401);
  return jsonResponse(await buildStatus(context, browser, status));
}

function oauthClient(config: AppConfig): OAuthClient {
  return {
    clientId: config.applicationId,
    clientSecret: config.discordClientSecret,
    redirectUri: `${config.origin}/oauth/callback`,
  };
}

export async function handleOAuthStart(
  request: Request,
  context: JourneyContext,
): Promise<Response> {
  if (!hasExactOrigin(request, context.config.origin)) return forbiddenResponse();
  const browser = await authenticateBrowser(request, context);
  if (browser === null) return restartResponse(401);
  if (!(await hasValidCsrf(request, context, browser))) return forbiddenResponse();

  const state = randomToken();
  const pkce = await createPkcePair();
  const started = await context.coordinator.beginAuthorization({
    browserDigest: browser.digest,
    stateDigest: await digestToken(state),
    verifier: pkce.verifier,
  });

  switch (started.kind) {
    case 'invalid':
      return restartResponse(410);
    case 'exhausted':
      return errorResponse(429, {
        code: 'restart_required',
        message: 'Too many sign-in attempts, press "Verify" in Discord to start again.',
      });
    case 'busy':
      return errorResponse(409, {
        code: 'rate_limited',
        message: 'A sign-in is still finishing, wait a moment and try again.',
        retryAfterSeconds: 5,
      });
    case 'started': {
      const client = oauthClient(context.config);
      return jsonResponse({
        authorizeUrl: buildAuthorizeUrl({
          clientId: client.clientId,
          redirectUri: client.redirectUri,
          state,
          codeChallenge: pkce.challenge,
        }),
      });
    }
  }
}

// every outcome redirects to the page, which reads the safe result through the status endpoint
export async function handleOAuthCallback(
  request: Request,
  context: JourneyContext,
): Promise<Response> {
  const home = redirectResponse('/');
  const callback = parseCallback(new URL(request.url));
  if (callback.kind === 'invalid') return home;

  const browser = await authenticateBrowser(request, context);
  if (browser === null) return home;

  const stateDigest = await digestToken(callback.state);
  if (callback.kind === 'denied') {
    await context.coordinator.recordAuthorizationDenied({
      browserDigest: browser.digest,
      stateDigest,
    });
    return home;
  }

  const claimed = await context.coordinator.consumeAuthorization({
    browserDigest: browser.digest,
    stateDigest,
  });
  if (claimed.kind !== 'claimed') return home;

  const identityUserId = await resolveIdentity(context, callback.code, claimed.verifier);
  await context.coordinator.finishAuthorization({
    browserDigest: browser.digest,
    claimId: claimed.claimId,
    identityUserId,
  });
  return home;
}

// tokens exist only in this function, revocation is best effort and must not delay the member
async function resolveIdentity(
  context: JourneyContext,
  code: string,
  verifier: string,
): Promise<string | null> {
  const client = oauthClient(context.config);
  const token = await exchangeCode(client, { code, verifier });
  if (token.kind !== 'ok') return null;

  const identity = await fetchIdentity(token.accessToken);
  context.execution.waitUntil(revokeToken(client, token.accessToken));
  return identity.kind === 'ok' ? identity.userId : null;
}

export async function handleChallengeSubmit(
  request: Request,
  context: JourneyContext,
): Promise<Response> {
  if (!hasExactOrigin(request, context.config.origin)) return forbiddenResponse();
  if (!hasJsonContentType(request)) return invalidRequestResponse();
  const browser = await authenticateBrowser(request, context);
  if (browser === null) return restartResponse(401);
  if (!(await hasValidCsrf(request, context, browser))) return forbiddenResponse();

  const body = await readJsonObject(request);
  const token = body?.['token'];
  if (!isPlausibleChallengeToken(token)) return invalidRequestResponse();

  const claim = await context.coordinator.claimSubmission({
    browserDigest: browser.digest,
    tokenDigest: await digestToken(token),
  });

  switch (claim.kind) {
    case 'invalid':
      return restartResponse(410);
    case 'in_flight':
      return statusResponse(context, browser, await context.coordinator.readStatus(browser.digest));
    case 'rate_limited':
      return errorResponse(429, {
        code: 'rate_limited',
        message: CODE_MESSAGES.rate_limited ?? 'Too many attempts.',
        retryAfterSeconds: retryAfterSeconds(claim.retryAfterMs),
      });
    case 'claimed':
  }

  const cdata = await deriveToken({
    ...capabilityOptions(context),
    purpose: 'challenge',
    handle: browser.handle,
    expirySeconds: browser.expirySeconds,
  });
  const verdict = await verifyChallenge({
    secret: context.config.turnstileSecretKey,
    token,
    remoteIp: request.headers.get('CF-Connecting-IP'),
    idempotencyKey: claim.idempotencyKey,
    expected: { hostname: context.config.hostname, cdata },
    nowMs: Date.now(),
  });

  const finalized = await context.coordinator.finalizeChallenge({
    browserDigest: browser.digest,
    claimId: claim.claimId,
    outcome: verdict.kind,
  });

  switch (finalized.kind) {
    case 'queued':
      return statusResponse(context, browser, finalized.status);
    case 'stale':
      return restartResponse(410);
    case 'unavailable':
      return errorResponse(503, {
        code: 'challenge_unavailable',
        message: CODE_MESSAGES.challenge_unavailable ?? 'Please try again.',
        retryAfterSeconds: 5,
      });
    case 'failed':
      return errorResponse(finalized.retryAfterMs === null ? 400 : 429, {
        code: finalized.retryAfterMs === null ? 'challenge_failed' : 'rate_limited',
        message: CODE_MESSAGES.challenge_failed ?? 'Please try again.',
        ...(finalized.retryAfterMs === null
          ? {}
          : { retryAfterSeconds: retryAfterSeconds(finalized.retryAfterMs) }),
      });
  }
}

// 202 = accepted, the outcome is still being worked on
async function statusResponse(
  context: JourneyContext,
  browser: BrowserSession,
  status: AttemptStatus | null,
): Promise<Response> {
  if (status === null) return restartResponse(410);
  return jsonResponse(await buildStatus(context, browser, status), 202);
}
