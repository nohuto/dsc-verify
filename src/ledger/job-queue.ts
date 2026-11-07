import type { Store } from './sqlite';
import { execute, selectAll, selectOne, updatedRows } from './sqlite';

const JOB_LEASE_MS = 60 * 1000;

type JobKind =
  | 'grant'
  | 'remove'
  | 'reconcile'
  | 'log_post'
  | 'log_reconcile'
  | 'log_delete'
  | 'log_sweep'
  | 'panel';

type MutationState = 'none' | 'in_flight' | 'uncertain' | 'applied';

type NewJob = {
  readonly operationKey: string;
  readonly kind: JobKind;
  readonly nextRunAt: number;
  readonly nowMs: number;
  readonly userId?: string;
  readonly joinedAtMs?: number | null;
  readonly generation?: number;
  readonly roleRevision?: number;
  readonly actorId?: string | null;
  readonly sessionId?: string | null;
  readonly eventId?: string;
  readonly payload?: string;
  readonly deadlineAt?: number | null;
  readonly revive?: boolean;
};

const REVIVE_FINISHED = `UPDATE SET state = 'queued', next_run_at = excluded.next_run_at, attempts = 0,
  lease_id = NULL, lease_expires_at = NULL, result = NULL, updated_at = excluded.updated_at
  WHERE jobs.state IN ('done', 'cancelled')`;

export function insertJob(store: Store, job: NewJob): boolean {
  const inserted = updatedRows(
    store,
    `INSERT INTO jobs
       (id, operation_key, kind, state, user_id, joined_at, generation, role_revision, actor_id,
        session_id, event_id, payload, deadline_at, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operation_key) DO ${job.revive === true ? REVIVE_FINISHED : 'NOTHING'}
     RETURNING id`,
    crypto.randomUUID(),
    job.operationKey,
    job.kind,
    job.userId ?? null,
    job.joinedAtMs ?? null,
    job.generation ?? null,
    job.roleRevision ?? null,
    job.actorId ?? null,
    job.sessionId ?? null,
    job.eventId ?? null,
    job.payload ?? null,
    job.deadlineAt ?? null,
    job.nextRunAt,
    job.nowMs,
    job.nowMs,
  );
  return inserted > 0;
}

export function hasOpenEventJob(
  store: Store,
  eventId: string,
  exceptJobId: string | null,
): boolean {
  const open = selectOne<{ id: string }>(
    store,
    `SELECT id FROM jobs
     WHERE event_id = ? AND id IS NOT ? AND state IN ('queued', 'running') LIMIT 1`,
    eventId,
    exceptJobId,
  );
  return open !== undefined;
}

export type JobRow = {
  id: string;
  kind: JobKind;
  user_id: string | null;
  joined_at: number | null;
  generation: number | null;
  role_revision: number | null;
  actor_id: string | null;
  session_id: string | null;
  event_id: string | null;
  payload: string | null;
  deadline_at: number | null;
  attempts: number;
  lease_id: string | null;
  mutation_state: string;
  created_at: number;
};

const JOB_COLUMNS = `id, kind, user_id, joined_at, generation, role_revision, actor_id, session_id,
  event_id, payload, deadline_at, attempts, lease_id, mutation_state, created_at`;

export function claimDueJob(store: Store, nowMs: number): JobRow | null {
  return store.transactionSync(() => {
    const job = selectOne<JobRow>(
      store,
      `SELECT ${JOB_COLUMNS} FROM jobs
       WHERE next_run_at IS NOT NULL AND next_run_at <= ?
         AND (state = 'queued' OR (state = 'running' AND lease_expires_at <= ?))
       ORDER BY CASE WHEN kind IN ('grant', 'remove', 'reconcile') THEN 0 ELSE 1 END,
                next_run_at, created_at
       LIMIT 1`,
      nowMs,
      nowMs,
    );
    if (job === undefined) return null;

    const leaseId = crypto.randomUUID();
    const mutationState = job.mutation_state === 'in_flight' ? 'uncertain' : job.mutation_state;
    execute(
      store,
      `UPDATE jobs
       SET state = 'running', lease_id = ?, lease_expires_at = ?, mutation_state = ?, updated_at = ?
       WHERE id = ?`,
      leaseId,
      nowMs + JOB_LEASE_MS,
      mutationState,
      nowMs,
      job.id,
    );
    return { ...job, lease_id: leaseId, mutation_state: mutationState };
  });
}

export function markMutation(
  store: Store,
  job: JobRow,
  mutationState: MutationState,
  nowMs: number,
): boolean {
  const updated = updatedRows(
    store,
    `UPDATE jobs SET mutation_state = ?, updated_at = ?
     WHERE id = ? AND lease_id = ? RETURNING id`,
    mutationState,
    nowMs,
    job.id,
    job.lease_id,
  );
  return updated > 0;
}

export function bindRemovalJoin(store: Store, job: JobRow, joinedAtMs: number): void {
  execute(store, 'UPDATE jobs SET joined_at = ? WHERE id = ?', joinedAtMs, job.id);
}

export function rescheduleJob(
  store: Store,
  job: JobRow,
  input: { readonly nextRunAt: number; readonly countAttempt: boolean; readonly nowMs: number },
): void {
  execute(
    store,
    `UPDATE jobs
     SET state = 'queued', next_run_at = ?, attempts = attempts + ?, lease_id = NULL,
         lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND lease_id = ?`,
    input.nextRunAt,
    input.countAttempt ? 1 : 0,
    input.nowMs,
    job.id,
    job.lease_id,
  );
}

export function finishJob(
  store: Store,
  job: JobRow,
  input: {
    readonly state: 'done' | 'cancelled' | 'unresolved';
    readonly result: string;
    readonly nowMs: number;
  },
): boolean {
  // erasure can flag a running job, read the flag as the row finishes
  const finished = selectAll<{ erase_on_finish: number }>(
    store,
    `UPDATE jobs
     SET state = ?, result = ?, next_run_at = NULL, lease_id = NULL, lease_expires_at = NULL,
         updated_at = ?
     WHERE id = ? AND lease_id = ?
     RETURNING erase_on_finish`,
    input.state,
    input.result,
    input.nowMs,
    job.id,
    job.lease_id,
  )[0];
  if (finished === undefined) return false;
  if (finished.erase_on_finish !== 0 && job.user_id !== null) {
    finishErasure(store, job.user_id, job.id);
  }
  return true;
}

// identifiers an erasure kept alive for a pending removal go away with the last such job
function finishErasure(store: Store, userId: string, jobId: string): void {
  execute(store, 'DELETE FROM jobs WHERE id = ?', jobId);
  const remaining = selectOne<{ id: string }>(
    store,
    `SELECT id FROM jobs WHERE user_id = ? AND state IN ('queued', 'running') LIMIT 1`,
    userId,
  );
  if (remaining !== undefined) return;
  execute(store, 'DELETE FROM jobs WHERE user_id = ?', userId);
  execute(store, 'DELETE FROM members WHERE user_id = ?', userId);
}

export function nextDueAt(store: Store): number | null {
  const due = selectOne<{ next: number | null }>(
    store,
    `SELECT min(CASE WHEN state = 'running' THEN lease_expires_at ELSE next_run_at END) AS next
     FROM jobs WHERE next_run_at IS NOT NULL`,
  );
  return due?.next ?? null;
}
