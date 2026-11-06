// no transaction spans SQLite and discord, these record intent and observation, never effect

import { RECONCILE_FIRST_DELAY_MS } from '../coordinator/retry-schedule';
import { STAFF_GRANT_DEADLINE_MS } from '../admission/admission-limits';
import type { AuditKind } from '../audit/audit-events';
import { hasOperation, insertAuditEvent } from './audit-ledger';
import type { StaffCommandResult } from './audit-ledger';
import { finishJob, insertJob } from './job-queue';
import type { JobRow } from './job-queue';
import { advanceRoleIntent, ensureMember } from './member-intents';
import { cancelOpenSessions } from './session-ledger';
import type { Store } from './sqlite';
import { execute, selectOne, updatedRows } from './sqlite';

type ResetResult = StaffCommandResult | { readonly kind: 'queued_with_uncertainty' };

function reconcileKey(userId: string): string {
  return `reconcile:${userId}`;
}

function hasUncertainRoleMutation(store: Store, userId: string): boolean {
  const pending = selectOne<{ id: string }>(
    store,
    `SELECT id FROM jobs
     WHERE user_id = ? AND kind IN ('grant', 'remove')
       AND mutation_state IN ('in_flight', 'uncertain')
       AND state IN ('queued', 'running')`,
    userId,
  );
  return pending !== undefined;
}

// one reconciliation job per member, a new uncertainty restarts its 5/30/120 second observations
export function scheduleReconcile(
  store: Store,
  input: {
    readonly userId: string;
    readonly joinedAtMs: number | null;
    readonly firstRunAt: number;
    readonly nowMs: number;
  },
): void {
  const key = reconcileKey(input.userId);
  const restarted = updatedRows(
    store,
    `UPDATE jobs
     SET state = 'queued', attempts = 0, joined_at = COALESCE(?, joined_at), next_run_at = ?,
         lease_id = NULL, lease_expires_at = NULL, result = NULL, created_at = ?, updated_at = ?
     WHERE operation_key = ?
     RETURNING id`,
    input.joinedAtMs,
    input.firstRunAt,
    input.nowMs,
    input.nowMs,
    key,
  );
  if (restarted > 0) return;
  insertJob(store, {
    operationKey: key,
    kind: 'reconcile',
    userId: input.userId,
    joinedAtMs: input.joinedAtMs,
    nextRunAt: input.firstRunAt,
    nowMs: input.nowMs,
  });
}

// later authorized intent inherits outstanding uncertainty instead of ending its observation
function restartOpenReconcile(store: Store, userId: string, nowMs: number): void {
  execute(
    store,
    `UPDATE jobs
     SET attempts = 0, created_at = ?, next_run_at = ?, updated_at = ?
     WHERE operation_key = ? AND state = 'queued'`,
    nowMs,
    nowMs + RECONCILE_FIRST_DELAY_MS,
    nowMs,
    reconcileKey(userId),
  );
}

export function requestStaffGrant(
  store: Store,
  input: {
    readonly operationId: string;
    readonly userId: string;
    readonly joinedAtMs: number;
    readonly actorId: string;
    readonly reason: string;
    readonly nowMs: number;
  },
): StaffCommandResult {
  return store.transactionSync(() => {
    const { operationId, userId, nowMs } = input;
    if (hasOperation(store, operationId)) return { kind: 'duplicate' };

    const { generation, revision } = advanceRoleIntent(store, userId, 'present', nowMs);
    insertJob(store, {
      operationKey: `grant:staff:${operationId}`,
      kind: 'grant',
      userId,
      joinedAtMs: input.joinedAtMs,
      generation,
      roleRevision: revision,
      actorId: input.actorId,
      deadlineAt: nowMs + STAFF_GRANT_DEADLINE_MS,
      nextRunAt: nowMs,
      nowMs,
    });
    insertAuditEvent(
      store,
      {
        kind: 'staff_approved',
        subjectId: userId,
        actorId: input.actorId,
        outcome: 'approval_queued',
        reason: input.reason,
        operationId,
      },
      nowMs,
    );
    return { kind: 'queued' };
  });
}

export function resetMember(
  store: Store,
  input: {
    readonly operationId: string;
    readonly userId: string;
    readonly joinedAtMs: number | null;
    readonly actorId: string;
    readonly reason: string;
    readonly nowMs: number;
  },
): ResetResult {
  return store.transactionSync(() => {
    const { operationId, userId, nowMs } = input;
    if (hasOperation(store, operationId)) return { kind: 'duplicate' };

    ensureMember(store, userId, nowMs);
    execute(
      store,
      'UPDATE members SET generation = generation + 1, updated_at = ? WHERE user_id = ?',
      nowMs,
      userId,
    );
    const { generation, revision } = advanceRoleIntent(store, userId, 'absent', nowMs);

    cancelOpenSessions(store, userId);
    const hadUncertainty = hasUncertainRoleMutation(store, userId);
    execute(
      store,
      `UPDATE jobs SET state = 'cancelled', next_run_at = NULL, result = 'reset', updated_at = ?
       WHERE user_id = ? AND kind = 'grant' AND state = 'queued'`,
      nowMs,
      userId,
    );
    insertJob(store, {
      operationKey: `remove:${operationId}`,
      kind: 'remove',
      userId,
      joinedAtMs: input.joinedAtMs,
      generation,
      roleRevision: revision,
      actorId: input.actorId,
      nextRunAt: nowMs,
      nowMs,
    });
    if (hadUncertainty) {
      scheduleReconcile(store, {
        userId,
        joinedAtMs: input.joinedAtMs,
        firstRunAt: nowMs + RECONCILE_FIRST_DELAY_MS,
        nowMs,
      });
    }
    insertAuditEvent(
      store,
      {
        kind: 'staff_reset',
        subjectId: userId,
        actorId: input.actorId,
        outcome: 'removal_queued',
        reason: input.reason,
        operationId,
      },
      nowMs,
    );
    return hadUncertainty ? { kind: 'queued_with_uncertainty' } : { kind: 'queued' };
  });
}

export function confirmGrant(store: Store, job: JobRow, nowMs: number): boolean {
  return store.transactionSync(() => {
    if (!finishJob(store, job, { state: 'done', result: 'confirmed', nowMs })) return false;
    if (job.session_id !== null) {
      execute(
        store,
        `UPDATE sessions SET state = 'verified' WHERE id = ? AND state = 'grant_queued'`,
        job.session_id,
      );
    }
    if (job.user_id !== null) {
      restartOpenReconcile(store, job.user_id, nowMs);
      insertAuditEvent(
        store,
        {
          kind: 'admission_confirmed',
          subjectId: job.user_id,
          actorId: job.actor_id,
          outcome: 'role_confirmed',
          reason: null,
        },
        nowMs,
      );
    }
    return true;
  });
}

export function abandonGrant(
  store: Store,
  job: JobRow,
  input: {
    readonly outcome: string;
    readonly sessionState: 'blocked' | 'expired' | 'cancelled';
    readonly nowMs: number;
  },
): void {
  store.transactionSync(() => {
    const { outcome, sessionState, nowMs } = input;
    if (!finishJob(store, job, { state: 'cancelled', result: outcome, nowMs })) return;
    if (job.session_id !== null) {
      execute(
        store,
        `UPDATE sessions SET state = ?, block_reason = ? WHERE id = ? AND state = 'grant_queued'`,
        sessionState,
        outcome,
        job.session_id,
      );
    }
    if (job.user_id !== null) {
      execute(
        store,
        `UPDATE members SET desired_role = NULL, updated_at = ?
         WHERE user_id = ? AND role_revision = ? AND desired_role = 'present'`,
        nowMs,
        job.user_id,
        job.role_revision,
      );
      if (job.mutation_state === 'uncertain') {
        scheduleReconcile(store, {
          userId: job.user_id,
          joinedAtMs: job.joined_at,
          firstRunAt: nowMs + RECONCILE_FIRST_DELAY_MS,
          nowMs,
        });
      }
      insertAuditEvent(
        store,
        {
          kind: sessionState === 'expired' ? 'admission_expired' : 'admission_blocked',
          subjectId: job.user_id,
          actorId: job.actor_id,
          outcome,
          reason: null,
        },
        nowMs,
      );
    }
  });
}

export function recordRoleOutcome(
  store: Store,
  job: JobRow,
  input: {
    readonly state: 'done' | 'cancelled' | 'unresolved';
    readonly result: string;
    readonly auditKind: AuditKind;
    readonly nowMs: number;
  },
): void {
  store.transactionSync(() => {
    const { state, result, auditKind, nowMs } = input;
    const stored = selectOne<{ erase_on_finish: number }>(
      store,
      'SELECT erase_on_finish FROM jobs WHERE id = ?',
      job.id,
    );
    const isErased = stored === undefined || stored.erase_on_finish !== 0;
    if (!finishJob(store, job, { state, result, nowMs })) return;
    insertAuditEvent(
      store,
      {
        kind: auditKind,
        subjectId: isErased ? null : job.user_id,
        actorId: null,
        outcome: result,
        reason: null,
      },
      nowMs,
    );
  });
}

type LatestGrant = {
  readonly deadlineAtMs: number;
  readonly actorId: string | null;
};

export function readLatestGrant(
  store: Store,
  userId: string,
  revision: number,
): LatestGrant | null {
  const grant = selectOne<{ deadline_at: number | null; actor_id: string | null }>(
    store,
    `SELECT deadline_at, actor_id FROM jobs
     WHERE user_id = ? AND kind = 'grant' AND role_revision = ?
     ORDER BY created_at DESC LIMIT 1`,
    userId,
    revision,
  );
  if (grant === undefined || grant.deadline_at === null) return null;
  return { deadlineAtMs: grant.deadline_at, actorId: grant.actor_id };
}
