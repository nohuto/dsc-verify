// public browser and server contract, must stay free of server imports

export const VERIFICATION_STATES = [
  'awaiting_oauth',
  'awaiting_challenge',
  'validating',
  'grant_queued',
  'verified',
  'blocked',
  'expired',
  'cancelled',
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const PUBLIC_CODES = [
  'wrong_account',
  'oauth_denied',
  'oauth_failed',
  'challenge_failed',
  'challenge_unavailable',
  'rate_limited',
  'restart_required',
  'invalid_request',
  'forbidden',
  'not_found',
  'unavailable',
] as const;

export type PublicCode = (typeof PUBLIC_CODES)[number];

export type TurnstileChallenge = {
  readonly siteKey: string;
  readonly action: string;
  readonly cdata: string;
};

export type StatusResponse = {
  readonly state: VerificationState;
  readonly message: string;
  readonly code?: PublicCode;
  readonly retryAfterSeconds?: number;
  readonly expiresAt?: string;
  readonly csrfToken?: string;
  readonly challenge?: TurnstileChallenge;
};

export type ErrorResponse = {
  readonly code: PublicCode;
  readonly message: string;
  readonly retryAfterSeconds?: number;
};

export const CSRF_HEADER = 'x-verify-csrf';
export const ENTRY_FRAGMENT_KEY = 'v';
export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

export const ROUTES = {
  session: '/api/session',
  verify: '/api/verify',
  oauthStart: '/oauth/start',
  oauthCallback: '/oauth/callback',
  interactions: '/discord/interactions',
  health: '/health',
  source: '/source',
  support: '/support',
} as const;
