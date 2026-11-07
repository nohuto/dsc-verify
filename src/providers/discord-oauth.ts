import { DISCORD_AUTHORIZE_URL } from '../../shared/browser-contract';
import { isCanonicalKeyEncoding } from '../crypto/canonical-encoding';
import { id, record } from './discord-fields';
import { DISCORD_API_BASE, UPSTREAM_TIMEOUT_MS, USER_AGENT } from './discord-rest';

export const DISCORD_ISSUER = 'https://discord.com';
export const OAUTH_SCOPE = 'identify';

const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const REVOKE_URL = 'https://discord.com/api/oauth2/token/revoke';

type CallbackParams =
  | { readonly kind: 'success'; readonly code: string; readonly state: string }
  | { readonly kind: 'denied'; readonly state: string }
  | { readonly kind: 'invalid' };
type TokenOutcome =
  | { readonly kind: 'ok'; readonly accessToken: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'unavailable' };
type IdentityOutcome =
  | { readonly kind: 'ok'; readonly userId: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'unavailable' };
export type OAuthClient = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    scope: OAUTH_SCOPE,
    redirect_uri: options.redirectUri,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

export function parseCallback(url: URL): CallbackParams {
  const params = url.searchParams;
  for (const key of ['state', 'code', 'iss', 'error']) {
    if (params.getAll(key).length > 1) return { kind: 'invalid' };
  }
  const state = params.get('state');
  if (state === null || !isCanonicalKeyEncoding(state)) return { kind: 'invalid' };
  const issuer = params.get('iss');
  if (issuer !== null && issuer !== DISCORD_ISSUER) return { kind: 'invalid' };
  const code = params.get('code');
  if (params.has('error')) {
    return code === null ? { kind: 'denied', state } : { kind: 'invalid' };
  }
  if (issuer !== DISCORD_ISSUER || code === null || !/^[A-Za-z0-9._~-]{1,512}$/.test(code))
    return { kind: 'invalid' };
  return { kind: 'success', code, state };
}

// discord client IDs and secrets are ASCII
function basicAuth(client: OAuthClient): string {
  return `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`;
}

export async function exchangeCode(
  client: OAuthClient,
  options: { code: string; verifier: string },
): Promise<TokenOutcome> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(client),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: client.redirectUri,
        code_verifier: options.verifier,
      }).toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (response.status >= 500) return { kind: 'unavailable' };
    // 401 = discord refused the client credentials, every sign in fails until the secret is fixed
    if (response.status === 401) {
      console.error(
        JSON.stringify({ event: 'configuration_invalid', detail: 'DISCORD_CLIENT_SECRET' }),
      );
    }
    if (response.status !== 200) return { kind: 'rejected' };
    const body: unknown = await response.json().catch(() => undefined);
    if (
      !record(body) ||
      typeof body['access_token'] !== 'string' ||
      body['access_token'].trim().length === 0 ||
      typeof body['token_type'] !== 'string' ||
      body['token_type'].toLowerCase() !== 'bearer' ||
      typeof body['scope'] !== 'string' ||
      !body['scope'].split(/\s+/).includes(OAUTH_SCOPE)
    )
      return { kind: 'rejected' };
    return { kind: 'ok', accessToken: body['access_token'] };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function fetchIdentity(accessToken: string): Promise<IdentityOutcome> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (response.status >= 500) return { kind: 'unavailable' };
    if (response.status !== 200) return { kind: 'rejected' };
    const body: unknown = await response.json().catch(() => undefined);
    if (!record(body) || !id(body['id'])) return { kind: 'rejected' };
    return { kind: 'ok', userId: body['id'] };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function revokeToken(
  client: OAuthClient,
  accessToken: string,
): Promise<'revoked' | 'failed'> {
  try {
    const response = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(client),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }).toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: 'manual',
    });
    return response.ok ? 'revoked' : 'failed';
  } catch {
    return 'failed';
  }
}
