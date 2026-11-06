import type { PublicCode, VerificationState } from '../../shared/browser-contract';
import {
  MAX_AUTHORIZATIONS_PER_ATTEMPT,
  MAX_BROWSER_ATTEMPTS_PER_SESSION,
  MAX_SESSION_STARTS_PER_WINDOW,
  OAUTH_CLAIM_LEASE_MS,
  OAUTH_STATE_TTL_MS,
  SESSION_START_WINDOW_MS,
  SUBMISSION_LEASE_MS,
} from '../admission/admission-limits';
import { insertAuditEvent } from './audit-ledger';
import { readSettings } from './guild-settings';
import { insertJob } from './job-queue';
import {
  advanceRoleIntent,
  ensureMember,
  failureLockoutMs,
  recentFailureTimes,
  selectMember,
} from './member-intents';
import type { Store } from './sqlite';
import { execute, selectAll, selectOne } from './sqlite';

type BeginSessionResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number };

export function beginSession(
  store: Store,
  input: {
    readonly operationId: string;
    readonly userId: string;
    readonly joinedAtMs: number;
    readonly entryDigest: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  },
): BeginSessionResult {
  return store.transactionSync(() => {
    const { operationId, userId, nowMs } = input;
    const duplicate = selectOne<{ id: string }>(
      store,
      'SELECT id FROM sessions WHERE operation_id = ?',
      operationId,
    );
    if (duplicate !== undefined) return { kind: 'duplicate' };
    if (readSettings(store).paused !== 0) return { kind: 'paused' };

    const queued = selectOne<{ id: string }>(
      store,
      `SELECT id FROM sessions WHERE user_id = ? AND state = 'grant_queued' AND expires_at > ?`,
      userId,
      nowMs,
    );
    if (queued !== undefined) return { kind: 'in_progress' };

    const recent = selectAll<{ created_at: number }>(
      store,
      'SELECT created_at FROM sessions WHERE user_id = ? AND created_at > ? ORDER BY created_at',
      userId,
      nowMs - SESSION_START_WINDOW_MS,
    );
    const oldest = recent[0];
    if (oldest !== undefined && recent.length >= MAX_SESSION_STARTS_PER_WINDOW) {
      return {
        kind: 'rate_limited',
        retryAfterMs: oldest.created_at + SESSION_START_WINDOW_MS - nowMs,
      };
    }

    const member = ensureMember(store, userId, nowMs);
    // no grant queued here, this only replaces unfinished sessions and drops their verifiers
    cancelOpenSessions(store, userId);
    execute(
      store,
      `INSERT INTO sessions
         (id, entry_digest, operation_id, user_id, joined_at, generation, state, created_at,
          expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'awaiting_oauth', ?, ?)`,
      crypto.randomUUID(),
      input.entryDigest,
      operationId,
      userId,
      input.joinedAtMs,
      member.generation,
      nowMs,
      input.expiresAtMs,
    );
    return { kind: 'created' };
  });
}

type SessionRow = {
  id: string;
  user_id: string;
  joined_at: number;
  generation: number;
  state: string;
  block_reason: string | null;
  browser_attempts: number;
  expires_at: number;
};

const SESSION_COLUMNS =
  'id, user_id, joined_at, generation, state, block_reason, browser_attempts, expires_at';

const ACTIVE_PRE_GRANT_STATES: ReadonlySet<string> = new Set([
  'awaiting_oauth',
  'awaiting_challenge',
  'validating',
]);

function isSessionLive(session: SessionRow, nowMs: number): boolean {
  return ACTIVE_PRE_GRANT_STATES.has(session.state) && session.expires_at > nowMs;
}

type ExchangeEntryResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'reused' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'exhausted' };

export function exchangeEntry(
  store: Store,
  input: {
    readonly entryDigest: string;
    readonly browserDigest: string;
    readonly existingBrowserDigest: string | null;
    readonly nowMs: number;
  },
): ExchangeEntryResult {
  return store.transactionSync(() => {
    const session = selectOne<SessionRow>(
      store,
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE entry_digest = ?`,
      input.entryDigest,
    );
    if (session === undefined || !isSessionLive(session, input.nowMs)) return { kind: 'invalid' };

    if (input.existingBrowserDigest !== null) {
      const existing = selectOne<{ id: string }>(
        store,
        'SELECT id FROM attempts WHERE browser_digest = ? AND session_id = ?',
        input.existingBrowserDigest,
        session.id,
      );
      if (existing !== undefined) return { kind: 'reused' };
    }

    if (session.browser_attempts >= MAX_BROWSER_ATTEMPTS_PER_SESSION) return { kind: 'exhausted' };

    execute(
      store,
      'INSERT INTO attempts (id, session_id, browser_digest, created_at) VALUES (?, ?, ?, ?)',
      crypto.randomUUID(),
      session.id,
      input.browserDigest,
      input.nowMs,
    );
    execute(
      store,
      'UPDATE sessions SET browser_attempts = browser_attempts + 1 WHERE id = ?',
      session.id,
    );
    return { kind: 'created' };
  });
}

type AttemptRow = {
  id: string;
  session_id: string;
  state_digest: string | null;
  pkce_verifier: string | null;
  state_expires_at: number | null;
  authorization_count: number;
  oauth_claim_id: string | null;
  oauth_claim_expires_at: number | null;
  oauth_outcome: string | null;
  identity_confirmed: number;
  submission_claim_id: string | null;
  submission_claim_expires_at: number | null;
  submission_token_digest: string | null;
  submission_idempotency_key: string | null;
  challenge_outcome: string | null;
};

const ATTEMPT_COLUMNS = `id, session_id, state_digest, pkce_verifier, state_expires_at,
  authorization_count, oauth_claim_id, oauth_claim_expires_at, oauth_outcome, identity_confirmed,
  submission_claim_id, submission_claim_expires_at, submission_token_digest,
  submission_idempotency_key, challenge_outcome`;

function selectAttempt(
  store: Store,
  browserDigest: string,
): { attempt: AttemptRow; session: SessionRow } | undefined {
  const attempt = selectOne<AttemptRow>(
    store,
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE browser_digest = ?`,
    browserDigest,
  );
  if (attempt === undefined) return undefined;
  const session = selectOne<SessionRow>(
    store,
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`,
    attempt.session_id,
  );
  return session === undefined ? undefined : { attempt, session };
}

export type AttemptStatus = {
  readonly state: VerificationState;
  readonly code: PublicCode | null;
  readonly blockReason: string | null;
  readonly expiresAtMs: number;
};

function asPublicCode(value: string | null): PublicCode | null {
  switch (value) {
    case 'wrong_account':
    case 'oauth_denied':
    case 'oauth_failed':
    case 'challenge_failed':
    case 'challenge_unavailable':
    case 'rate_limited':
      return value;
    case null:
    default:
      return null;
  }
}

function deriveStatus(attempt: AttemptRow, session: SessionRow, nowMs: number): AttemptStatus {
  const base = { blockReason: session.block_reason, expiresAtMs: session.expires_at };

  if (ACTIVE_PRE_GRANT_STATES.has(session.state) && session.expires_at <= nowMs) {
    return { ...base, state: 'expired', code: null };
  }
  if (session.state === 'validating') {
    const claimIsLive =
      attempt.submission_claim_expires_at !== null && attempt.submission_claim_expires_at > nowMs;
    if (!claimIsLive) {
      return { ...base, state: 'awaiting_challenge', code: 'challenge_unavailable' };
    }
  }

  const isAwaitingChallenge = session.state === 'awaiting_challenge';
  if (isAwaitingChallenge && attempt.identity_confirmed === 0) {
    return { ...base, state: 'awaiting_oauth', code: asPublicCode(attempt.oauth_outcome) };
  }
  if (session.state === 'awaiting_oauth') {
    const claimExpired =
      attempt.oauth_claim_expires_at !== null && attempt.oauth_claim_expires_at <= nowMs;
    const outcome = claimExpired ? 'oauth_failed' : attempt.oauth_outcome;
    return { ...base, state: 'awaiting_oauth', code: asPublicCode(outcome) };
  }
  return {
    ...base,
    state: session.state as VerificationState,
    code: isAwaitingChallenge ? asPublicCode(attempt.challenge_outcome) : null,
  };
}

// read-only by design, bootstrap and status polling must never write to SQLite
export function readAttemptStatus(
  store: Store,
  browserDigest: string,
  nowMs: number,
): AttemptStatus | null {
  const found = selectAttempt(store, browserDigest);
  return found === undefined ? null : deriveStatus(found.attempt, found.session, nowMs);
}

type BeginAuthorizationResult =
  | { readonly kind: 'started' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'busy' };

export function beginAuthorization(
  store: Store,
  input: {
    readonly browserDigest: string;
    readonly stateDigest: string;
    readonly verifier: string;
    readonly nowMs: number;
  },
): BeginAuthorizationResult {
  return store.transactionSync(() => {
    const { nowMs } = input;
    const found = selectAttempt(store, input.browserDigest);
    if (found === undefined || !isSessionLive(found.session, nowMs)) return { kind: 'invalid' };
    const { attempt, session } = found;
    if (attempt.identity_confirmed !== 0) return { kind: 'invalid' };

    const claimIsLive =
      attempt.oauth_claim_expires_at !== null && attempt.oauth_claim_expires_at > nowMs;
    if (attempt.oauth_claim_id !== null && claimIsLive) return { kind: 'busy' };

    if (attempt.authorization_count >= MAX_AUTHORIZATIONS_PER_ATTEMPT) {
      return { kind: 'exhausted' };
    }

    // only the newest state stays valid, an expired claim is a failed attempt and is never revived
    execute(
      store,
      `UPDATE attempts
       SET state_digest = ?, pkce_verifier = ?, state_expires_at = ?,
           authorization_count = authorization_count + 1,
           oauth_claim_id = NULL, oauth_claim_expires_at = NULL, oauth_outcome = NULL
       WHERE id = ?`,
      input.stateDigest,
      input.verifier,
      Math.min(nowMs + OAUTH_STATE_TTL_MS, session.expires_at),
      attempt.id,
    );
    return { kind: 'started' };
  });
}

type ConsumeAuthorizationResult =
  | {
      readonly kind: 'claimed';
      readonly claimId: string;
      readonly verifier: string;
      readonly userId: string;
    }
  | { readonly kind: 'invalid' };

export function consumeAuthorization(
  store: Store,
  input: { readonly browserDigest: string; readonly stateDigest: string; readonly nowMs: number },
): ConsumeAuthorizationResult {
  return store.transactionSync(() => {
    const { nowMs } = input;
    const found = selectAttempt(store, input.browserDigest);
    if (found === undefined || !isSessionLive(found.session, nowMs)) return { kind: 'invalid' };
    const { attempt, session } = found;

    const stateMatches =
      attempt.state_digest !== null && attempt.state_digest === input.stateDigest;
    const stateIsLive = attempt.state_expires_at !== null && attempt.state_expires_at > nowMs;
    if (!stateMatches || !stateIsLive || attempt.pkce_verifier === null) {
      return { kind: 'invalid' };
    }

    const claimId = crypto.randomUUID();
    execute(
      store,
      `UPDATE attempts
       SET state_digest = NULL, pkce_verifier = NULL, state_expires_at = NULL,
           oauth_claim_id = ?, oauth_claim_expires_at = ?
       WHERE id = ?`,
      claimId,
      Math.min(nowMs + OAUTH_CLAIM_LEASE_MS, session.expires_at),
      attempt.id,
    );
    return {
      kind: 'claimed',
      claimId,
      verifier: attempt.pkce_verifier,
      userId: session.user_id,
    };
  });
}

type FinishAuthorizationResult =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'wrong_account' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'stale' };

export function finishAuthorization(
  store: Store,
  input: {
    readonly browserDigest: string;
    readonly claimId: string;
    readonly identityUserId: string | null;
    readonly nowMs: number;
  },
): FinishAuthorizationResult {
  return store.transactionSync(() => {
    const { nowMs } = input;
    const found = selectAttempt(store, input.browserDigest);
    if (found === undefined) return { kind: 'stale' };
    const { attempt, session } = found;

    const claimMatches = attempt.oauth_claim_id === input.claimId;
    const claimIsLive =
      attempt.oauth_claim_expires_at !== null && attempt.oauth_claim_expires_at > nowMs;
    if (!claimMatches || !claimIsLive || !isSessionLive(session, nowMs)) return { kind: 'stale' };

    if (input.identityUserId !== session.user_id) {
      const failure = input.identityUserId === null ? 'oauth_failed' : 'wrong_account';
      execute(
        store,
        `UPDATE attempts SET oauth_claim_id = NULL, oauth_claim_expires_at = NULL,
           oauth_outcome = ? WHERE id = ?`,
        failure,
        attempt.id,
      );
      return { kind: failure === 'oauth_failed' ? 'failed' : 'wrong_account' };
    }

    execute(
      store,
      `UPDATE attempts SET oauth_claim_id = NULL, oauth_claim_expires_at = NULL,
         oauth_outcome = NULL, identity_confirmed = 1 WHERE id = ?`,
      attempt.id,
    );
    execute(
      store,
      `UPDATE sessions SET state = 'awaiting_challenge'
       WHERE id = ? AND state = 'awaiting_oauth'`,
      session.id,
    );
    return { kind: 'confirmed' };
  });
}

export function recordAuthorizationDenied(
  store: Store,
  input: { readonly browserDigest: string; readonly stateDigest: string; readonly nowMs: number },
): boolean {
  return store.transactionSync(() => {
    const found = selectAttempt(store, input.browserDigest);
    if (found === undefined || !isSessionLive(found.session, input.nowMs)) return false;
    if (found.attempt.state_digest !== input.stateDigest) return false;
    execute(
      store,
      `UPDATE attempts SET state_digest = NULL, pkce_verifier = NULL, state_expires_at = NULL,
         oauth_outcome = 'oauth_denied' WHERE id = ?`,
      found.attempt.id,
    );
    return true;
  });
}

type ClaimSubmissionResult =
  | { readonly kind: 'claimed'; readonly claimId: string; readonly idempotencyKey: string }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number };

export function claimSubmission(
  store: Store,
  input: { readonly browserDigest: string; readonly tokenDigest: string; readonly nowMs: number },
): ClaimSubmissionResult {
  return store.transactionSync(() => {
    const { nowMs } = input;
    const found = selectAttempt(store, input.browserDigest);
    if (found === undefined || !isSessionLive(found.session, nowMs)) return { kind: 'invalid' };
    const { attempt, session } = found;
    if (attempt.identity_confirmed === 0) return { kind: 'invalid' };
    if (session.state === 'awaiting_oauth') return { kind: 'invalid' };

    const member = selectMember(store, session.user_id);
    if (member === undefined || member.generation !== session.generation) {
      return { kind: 'invalid' };
    }

    const retryAfterMs = failureLockoutMs(recentFailureTimes(member, nowMs), nowMs);
    if (retryAfterMs !== null) return { kind: 'rate_limited', retryAfterMs };

    // lock is per session, two tabs on separate attempts must not both validate
    const liveClaim = selectOne<{ id: string }>(
      store,
      `SELECT id FROM attempts
       WHERE session_id = ? AND submission_claim_id IS NOT NULL AND submission_claim_expires_at > ?`,
      session.id,
      nowMs,
    );
    if (liveClaim !== undefined) return { kind: 'in_flight' };

    const reusesToken = attempt.submission_token_digest === input.tokenDigest;
    const idempotencyKey =
      reusesToken && attempt.submission_idempotency_key !== null
        ? attempt.submission_idempotency_key
        : crypto.randomUUID();
    const claimId = crypto.randomUUID();

    execute(
      store,
      `UPDATE attempts SET submission_claim_id = NULL, submission_claim_expires_at = NULL
       WHERE session_id = ?`,
      session.id,
    );
    execute(
      store,
      `UPDATE attempts
       SET submission_claim_id = ?, submission_claim_expires_at = ?, submission_token_digest = ?,
           submission_idempotency_key = ?, challenge_outcome = NULL
       WHERE id = ?`,
      claimId,
      Math.min(nowMs + SUBMISSION_LEASE_MS, session.expires_at),
      input.tokenDigest,
      idempotencyKey,
      attempt.id,
    );
    execute(store, `UPDATE sessions SET state = 'validating' WHERE id = ?`, session.id);
    return { kind: 'claimed', claimId, idempotencyKey };
  });
}

type FinalizeChallengeResult =
  | { readonly kind: 'queued' }
  | { readonly kind: 'failed'; readonly retryAfterMs: number | null }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'stale' };

export function finalizeChallenge(
  store: Store,
  input: {
    readonly browserDigest: string;
    readonly claimId: string;
    readonly outcome: 'passed' | 'failed' | 'unavailable';
    readonly nowMs: number;
  },
): FinalizeChallengeResult {
  return store.transactionSync(() => {
    const { nowMs, outcome } = input;
    const found = selectAttempt(store, input.browserDigest);
    if (found === undefined) return { kind: 'stale' };
    const { attempt, session } = found;

    // suspended handler whose lease was replaced must not commit, even with a valid session
    const claimMatches = attempt.submission_claim_id === input.claimId;
    const claimIsLive =
      attempt.submission_claim_expires_at !== null && attempt.submission_claim_expires_at > nowMs;
    if (!claimMatches || !claimIsLive || session.state !== 'validating') return { kind: 'stale' };

    const member = selectMember(store, session.user_id);
    const isCurrent =
      member !== undefined &&
      member.generation === session.generation &&
      session.expires_at > nowMs;

    execute(
      store,
      `UPDATE attempts SET submission_claim_id = NULL, submission_claim_expires_at = NULL
       WHERE id = ?`,
      attempt.id,
    );

    if (!isCurrent) {
      execute(store, `UPDATE sessions SET state = 'expired' WHERE id = ?`, session.id);
      return { kind: 'stale' };
    }

    if (outcome === 'unavailable') {
      execute(store, `UPDATE sessions SET state = 'awaiting_challenge' WHERE id = ?`, session.id);
      execute(
        store,
        `UPDATE attempts SET challenge_outcome = 'challenge_unavailable' WHERE id = ?`,
        attempt.id,
      );
      return { kind: 'unavailable' };
    }

    if (outcome === 'failed') {
      const failures = [...recentFailureTimes(member, nowMs), nowMs];
      execute(
        store,
        'UPDATE members SET challenge_failures = ?, updated_at = ? WHERE user_id = ?',
        JSON.stringify(failures),
        nowMs,
        member.user_id,
      );
      execute(store, `UPDATE sessions SET state = 'awaiting_challenge' WHERE id = ?`, session.id);
      execute(
        store,
        `UPDATE attempts SET challenge_outcome = 'challenge_failed',
           submission_token_digest = NULL, submission_idempotency_key = NULL
         WHERE id = ?`,
        attempt.id,
      );
      return { kind: 'failed', retryAfterMs: failureLockoutMs(failures, nowMs) };
    }

    const { revision } = advanceRoleIntent(store, member.user_id, 'present', nowMs);
    execute(store, `UPDATE sessions SET state = 'grant_queued' WHERE id = ?`, session.id);
    execute(
      store,
      `UPDATE attempts SET submission_token_digest = NULL, submission_idempotency_key = NULL
       WHERE id = ?`,
      attempt.id,
    );
    insertJob(store, {
      operationKey: `grant:${session.id}`,
      kind: 'grant',
      userId: member.user_id,
      joinedAtMs: session.joined_at,
      generation: session.generation,
      roleRevision: revision,
      sessionId: session.id,
      deadlineAt: session.expires_at,
      nextRunAt: nowMs,
      nowMs,
    });
    insertAuditEvent(
      store,
      {
        kind: 'admission_queued',
        subjectId: member.user_id,
        actorId: null,
        outcome: 'challenge_passed',
        reason: null,
      },
      nowMs,
    );
    return { kind: 'queued' };
  });
}

export function cancelOpenSessions(store: Store, userId: string): void {
  execute(
    store,
    `UPDATE attempts
     SET state_digest = NULL, pkce_verifier = NULL, state_expires_at = NULL,
         oauth_claim_id = NULL, oauth_claim_expires_at = NULL,
         submission_claim_id = NULL, submission_claim_expires_at = NULL
     WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)`,
    userId,
  );
  execute(
    store,
    `UPDATE sessions SET state = 'cancelled'
     WHERE user_id = ?
       AND state IN ('awaiting_oauth', 'awaiting_challenge', 'validating', 'grant_queued')`,
    userId,
  );
}
