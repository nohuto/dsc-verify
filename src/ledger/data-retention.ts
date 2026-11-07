import { CHALLENGE_FAILURE_WINDOW_MS } from '../admission/admission-limits';
import { AUDIT_RETENTION_MS } from '../audit/audit-events';
import {
  deleteAuditEvent,
  enqueueErasureSearch,
  enqueueLogDelete,
  hasOperation,
  insertAuditEvent,
  parseMessageIds,
} from './audit-ledger';
import type { StaffCommandResult } from './audit-ledger';
import { hasOpenEventJob } from './job-queue';
import type { Store } from './sqlite';
import { execute, selectAll, selectOne, updatedRows } from './sqlite';

const TERMINAL_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

export function eraseMemberData(
  store: Store,
  input: {
    readonly operationId: string;
    readonly userId: string;
    readonly actorId: string;
    readonly nowMs: number;
  },
): StaffCommandResult {
  return store.transactionSync(() => {
    const { operationId, userId, actorId, nowMs } = input;
    if (hasOperation(store, operationId)) return { kind: 'duplicate' };

    execute(store, 'DELETE FROM sessions WHERE user_id = ?', userId);
    execute(
      store,
      `DELETE FROM jobs
       WHERE user_id = ? AND (kind = 'grant' OR state NOT IN ('queued', 'running'))`,
      userId,
    );

    // requested removals finish first, their identifiers are erased when the last job ends
    const pendingRemoval = updatedRows(
      store,
      `UPDATE jobs SET erase_on_finish = 1
       WHERE user_id = ? AND kind IN ('remove', 'reconcile') AND state IN ('queued', 'running')
       RETURNING id`,
      userId,
    );
    if (pendingRemoval === 0) execute(store, 'DELETE FROM members WHERE user_id = ?', userId);

    // records of actions this person took on others stay attributable until normal retention
    const events = selectAll<{ id: string; delivery_state: string; message_ids: string }>(
      store,
      'SELECT id, delivery_state, message_ids FROM audit_events WHERE subject_id = ?',
      userId,
    );
    for (const event of events) eraseAuditEvent(store, event, nowMs);

    insertAuditEvent(
      store,
      {
        kind: 'data_erased',
        subjectId: null,
        actorId: actorId === userId ? null : actorId,
        outcome: 'erased',
        reason: null,
        operationId,
      },
      nowMs,
    );
    return { kind: 'queued' };
  });
}

function eraseAuditEvent(
  store: Store,
  event: { id: string; delivery_state: string; message_ids: string },
  nowMs: number,
): void {
  const neverPosted = event.delivery_state === 'pending';
  if (neverPosted) {
    execute(store, `DELETE FROM jobs WHERE event_id = ?`, event.id);
    deleteAuditEvent(store, event.id);
    return;
  }

  execute(
    store,
    `UPDATE audit_events
     SET subject_id = NULL, actor_id = NULL, reason = NULL, outcome = 'erased',
         delivery_state = 'erasing', reconcile_cursor = NULL
     WHERE id = ?`,
    event.id,
  );
  if (parseMessageIds(event.message_ids).length > 0) enqueueLogDelete(store, event.id, nowMs);
  if (event.delivery_state !== 'delivered') enqueueErasureSearch(store, event.id, nowMs);
}

// rows are only removed once no valid work can reference them, returns whether any data is still
// retained
export function runCleanup(store: Store, nowMs: number, batchSize: number): boolean {
  return store.transactionSync(() => {
    execute(
      store,
      `UPDATE sessions SET state = 'expired'
       WHERE expires_at <= ? AND state IN ('awaiting_oauth', 'awaiting_challenge', 'validating')`,
      nowMs,
    );
    execute(
      store,
      `DELETE FROM sessions
       WHERE id IN (
         SELECT sessions.id FROM sessions
         WHERE sessions.expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM jobs
             WHERE jobs.session_id = sessions.id AND jobs.state IN ('queued', 'running')
           )
         LIMIT ?
       )`,
      nowMs,
      batchSize,
    );
    execute(
      store,
      `DELETE FROM jobs
       WHERE id IN (
         SELECT id FROM jobs
         WHERE state IN ('done', 'cancelled') AND updated_at <= ? LIMIT ?
       )`,
      nowMs - TERMINAL_JOB_RETENTION_MS,
      batchSize,
    );

    execute(
      store,
      `DELETE FROM jobs
       WHERE id IN (SELECT id FROM jobs WHERE state = 'unresolved' AND updated_at <= ? LIMIT ?)`,
      nowMs - AUDIT_RETENTION_MS,
      batchSize,
    );
    execute(
      store,
      `DELETE FROM audit_events
       WHERE delivery_state = 'erasing' AND message_ids = '[]'
         AND id NOT IN (
           SELECT event_id FROM jobs
           WHERE event_id IS NOT NULL AND state IN ('queued', 'running')
         )`,
    );

    // skip events whose deletion discord refused until their job expires, later ones keep moving
    const expired = selectAll<{ id: string; message_ids: string }>(
      store,
      `SELECT id, message_ids FROM audit_events
       WHERE expires_at <= ?
         AND id NOT IN (
           SELECT event_id FROM jobs
           WHERE kind = 'log_delete' AND state = 'unresolved' AND event_id IS NOT NULL
         )
       LIMIT ?`,
      nowMs,
      batchSize,
    );
    for (const event of expired) {
      if (parseMessageIds(event.message_ids).length > 0) {
        enqueueLogDelete(store, event.id, nowMs);
      } else if (!hasOpenEventJob(store, event.id, null)) {
        deleteAuditEvent(store, event.id);
      }
    }

    execute(
      store,
      `DELETE FROM members
       WHERE user_id NOT IN (SELECT user_id FROM sessions)
         AND user_id NOT IN (
           SELECT user_id FROM jobs
           WHERE user_id IS NOT NULL AND state IN ('queued', 'running', 'unresolved')
         )
         AND updated_at <= ?`,
      nowMs - CHALLENGE_FAILURE_WINDOW_MS,
    );

    // sweep jobs are left out, a finished sweep would otherwise request the next one forever
    const retained = selectOne<{ retained: number }>(
      store,
      `SELECT EXISTS (SELECT 1 FROM sessions) OR EXISTS (SELECT 1 FROM audit_events)
           OR EXISTS (SELECT 1 FROM members)
           OR EXISTS (SELECT 1 FROM jobs WHERE kind != 'log_sweep') AS retained`,
    );
    return retained?.retained === 1;
  });
}
