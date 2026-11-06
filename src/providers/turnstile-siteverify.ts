import { record } from './discord-fields';
import { UPSTREAM_TIMEOUT_MS, USER_AGENT } from './discord-rest';

export const TURNSTILE_ACTION = 'discord_verify';
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type ChallengeExpectation = {
  readonly hostname: string;
  readonly cdata: string;
};
export type SiteverifyOutcome =
  | { readonly kind: 'passed' }
  | { readonly kind: 'failed'; readonly reason: 'rejected' | 'context_mismatch' }
  | { readonly kind: 'unavailable' };

export function isPlausibleChallengeToken(token: unknown): token is string {
  return (
    typeof token === 'string' && token.length > 0 && token.length <= TURNSTILE_TOKEN_MAX_LENGTH
  );
}

export async function verifyChallenge(options: {
  secret: string;
  token: string;
  remoteIp: string | null;
  idempotencyKey: string;
  expected: ChallengeExpectation;
  nowMs: number;
  timeoutMs?: number;
}): Promise<SiteverifyOutcome> {
  if (!isPlausibleChallengeToken(options.token)) return { kind: 'failed', reason: 'rejected' };
  try {
    const body = {
      secret: options.secret,
      response: options.token,
      idempotency_key: options.idempotencyKey,
      ...(options.remoteIp === null ? {} : { remoteip: options.remoteIp }),
    };
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (!response.ok) return { kind: 'unavailable' };
    const result: unknown = await response.json();
    if (!record(result) || typeof result['success'] !== 'boolean') return { kind: 'unavailable' };
    if (result['success']) {
      const challengeTs =
        typeof result['challenge_ts'] === 'string' ? Date.parse(result['challenge_ts']) : NaN;
      const ageMs = options.nowMs - challengeTs;
      if (
        result['hostname'] !== options.expected.hostname ||
        result['action'] !== TURNSTILE_ACTION ||
        result['cdata'] !== options.expected.cdata ||
        !Number.isFinite(challengeTs) ||
        !Number.isFinite(ageMs) ||
        ageMs > 300_000 ||
        ageMs < -60_000
      )
        return { kind: 'failed', reason: 'context_mismatch' };
      return { kind: 'passed' };
    }
    const errors = result['error-codes'];
    if (!Array.isArray(errors) || !errors.every((code: unknown) => typeof code === 'string'))
      return { kind: 'unavailable' };
    if (
      errors.some(
        (code: unknown) =>
          code === 'internal-error' ||
          code === 'missing-input-secret' ||
          code === 'invalid-input-secret' ||
          code === 'bad-request',
      )
    )
      return { kind: 'unavailable' };
    return { kind: 'failed', reason: 'rejected' };
  } catch {
    return { kind: 'unavailable' };
  }
}
