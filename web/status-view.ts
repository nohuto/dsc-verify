// page logic, must stay free of DOM access

import {
  DISCORD_AUTHORIZE_URL,
  ENTRY_FRAGMENT_KEY,
  PUBLIC_CODES,
  VERIFICATION_STATES,
} from '../shared/browser-contract';
import type {
  StatusResponse,
  TurnstileChallenge,
  VerificationState,
} from '../shared/browser-contract';

const POLL_START_MS = 2_000;
const POLL_CEILING_MS = 15_000;
const POLL_GROWTH = 1.5;
// keeps server supplied wait inside the range setTimeout can represent
const MAX_WAIT_SECONDS = 86_400;

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const NETWORK_ERROR =
  'We could not reach the verification service. Check your connection and try again.';
const SESSION_LOST = 'We could not find an active verification session in this browser.';

export const RESTART_GUIDANCE =
  'Use /verify in Discord to get a new link, then finish in the same browser. Discord in-app browsers or switching to a different browser lose the session.';

export type Phase = 'oauth' | 'challenge' | 'progress' | 'final';

export type View = {
  readonly phase: Phase;
  readonly heading: string;
  readonly message: string;
  readonly guidance: string;
};

const VIEWS: Record<VerificationState, View> = {
  awaiting_oauth: {
    phase: 'oauth',
    heading: 'Sign in with Discord',
    message: 'Confirm which Discord account is verifying.',
    guidance: 'Use the same Discord account you use in the server.',
  },
  awaiting_challenge: {
    phase: 'challenge',
    heading: 'Complete the browser check',
    message: 'Your account is confirmed. One browser check is left.',
    guidance: 'This usually finishes by itself. If a checkbox appears, select it.',
  },
  validating: {
    phase: 'progress',
    heading: 'Checking your result',
    message: 'We are checking your result.',
    guidance: 'This usually takes a few seconds. You can leave this page open.',
  },
  grant_queued: {
    phase: 'progress',
    heading: 'Setting up your access',
    message: 'Your check passed and your role is being added.',
    guidance: 'This can take a moment. You can leave this page open.',
  },
  verified: {
    phase: 'final',
    heading: 'You are verified',
    message: 'Your access is ready.',
    guidance: 'You can close this page and return to Discord.',
  },
  blocked: {
    phase: 'final',
    heading: 'Verification could not continue',
    message: 'This verification cannot continue.',
    guidance: 'If you think this is a mistake, contact server staff through Help below.',
  },
  expired: {
    phase: 'final',
    heading: 'This session has ended',
    message: 'This verification session has expired.',
    guidance: RESTART_GUIDANCE,
  },
  cancelled: {
    phase: 'final',
    heading: 'Verification was cancelled',
    message: 'This verification session was cancelled.',
    guidance: RESTART_GUIDANCE,
  },
};

export type Problem = {
  readonly message: string;
  readonly restart: boolean;
  readonly retryAfterSeconds?: number;
};

export type Fetched = {
  readonly http: number;
  readonly body: unknown;
};

export type Reply = { readonly status: StatusResponse } | { readonly problem: Problem };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneOf = <T>(list: readonly T[], value: unknown): T | undefined =>
  list.find((item) => item === value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const seconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.ceil(value), MAX_WAIT_SECONDS)
    : undefined;

function parseChallenge(value: unknown): TurnstileChallenge | undefined {
  if (!isRecord(value)) return undefined;
  const siteKey = text(value['siteKey']);
  const action = text(value['action']);
  const cdata = text(value['cdata']);
  return siteKey && action && cdata ? { siteKey, action, cdata } : undefined;
}

export function parseStatus(body: unknown): StatusResponse | undefined {
  if (!isRecord(body)) return undefined;
  const state = oneOf(VERIFICATION_STATES, body['state']);
  if (!state) return undefined;
  const csrfToken = text(body['csrfToken']);
  const challenge = parseChallenge(body['challenge']);
  return {
    state,
    message: text(body['message']) ?? VIEWS[state].message,
    ...(csrfToken && { csrfToken }),
    ...(challenge && { challenge }),
  };
}

// undefined = request never produced a response
export function parseReply(fetched: Fetched | undefined): Reply {
  if (!fetched) return { problem: { message: NETWORK_ERROR, restart: false } };
  const status = parseStatus(fetched.body);
  if (status) return { status };
  const fields = isRecord(fetched.body) ? fetched.body : {};
  const code = oneOf(PUBLIC_CODES, fields['code']);
  const restart = code === 'restart_required' || fetched.http === 401 || fetched.http === 410;
  const fallback = restart ? SESSION_LOST : GENERIC_ERROR;
  if (!code) return { problem: { message: fallback, restart } };
  const retryAfterSeconds = seconds(fields['retryAfterSeconds']);
  return {
    problem: {
      message: text(fields['message']) ?? fallback,
      restart,
      ...(retryAfterSeconds && { retryAfterSeconds }),
    },
  };
}

// returns the normalized URL, what gets navigated to is exactly what was validated
export function parseAuthorizeUrl(body: unknown): string | undefined {
  const raw = isRecord(body) ? text(body['authorizeUrl']) : undefined;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.origin + url.pathname === DISCORD_AUTHORIZE_URL ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function readCapability(hash: string): string | undefined {
  return new URLSearchParams(hash.slice(1)).get(ENTRY_FRAGMENT_KEY) ?? undefined;
}

export function pollDelay(tries: number): number {
  return Math.min(POLL_CEILING_MS, POLL_START_MS * POLL_GROWTH ** tries);
}

function formatWait(wait: number): string {
  if (wait < 60) return wait === 1 ? '1 second' : `${wait} seconds`;
  const minutes = Math.ceil(wait / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function withWait(message: string, wait = 0): string {
  return wait > 0 ? `${message} Please wait ${formatWait(wait)} before trying again.` : message;
}

export function describe(status: StatusResponse): View {
  return { ...VIEWS[status.state], message: withWait(status.message, status.retryAfterSeconds) };
}
