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

const GENERIC_ERROR = 'Something went wrong, please try again.';
const NETWORK_ERROR =
  "The verification service can't be reached, check your connection and try again.";
const SESSION_LOST =
  "There's no active verification in this browser, press 'Verify' in Discord to get a new link and finish it in the same browser.";

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
    message: 'Sign in with the Discord account you use on this server.',
    guidance: '',
  },
  awaiting_challenge: {
    phase: 'challenge',
    heading: 'Browser check',
    message: 'Your account is confirmed, one quick browser check is left.',
    guidance: 'It usually passes by itself, if a checkbox shows up, select it.',
  },
  validating: {
    phase: 'progress',
    heading: 'Checking your result',
    message: 'This takes a few seconds.',
    guidance: '',
  },
  grant_queued: {
    phase: 'progress',
    heading: 'Adding your role',
    message: 'You passed, your role is being added, this can take a moment.',
    guidance: '',
  },
  verified: {
    phase: 'final',
    heading: 'You are verified',
    message: 'Your role is added, you can close this page and go back to Discord.',
    guidance: '',
  },
  blocked: {
    phase: 'final',
    heading: 'Verification stopped',
    message:
      "This verification can't continue, if you think that's a mistake, contact staff through 'Help' below.",
    guidance: '',
  },
  expired: {
    phase: 'final',
    heading: 'Link expired',
    message:
      'This verification has expired, press "Verify" in Discord to get a new link and finish it in the same browser.',
    guidance: '',
  },
  cancelled: {
    phase: 'final',
    heading: 'Verification cancelled',
    message:
      'This verification was cancelled, press "Verify" in Discord to get a new link and finish it in the same browser.',
    guidance: '',
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
