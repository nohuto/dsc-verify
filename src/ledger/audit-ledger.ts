import { auditExpiresAtMs, createEventId } from '../audit/audit-events';
import type { AuditKind } from '../audit/audit-events';
import { insertJob } from './job-queue';
import type { Store } from './sqlite';
import { execute, selectOne } from './sqlite';

type NewAuditEvent = {
  readonly kind: AuditKind;
  readonly subjectId: string | null;
  readonly actorId: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly operationId?: string;
};

export type StaffCommandResult = { readonly kind: 'queued' } | { readonly kind: 'duplicate' };

export function hasOperation(store: Store, operationId: string): boolean {
  const existing = selectOne<{ id: string }>(
    store,
    'SELECT id FROM audit_events WHERE operation_id = ?',
    operationId,
  );
  return existing !== undefined;
}

export function insertAuditEvent(store: Store, event: NewAuditEvent, nowMs: number): void {
  const id = createEventId();
  execute(
    store,
    `INSERT INTO audit_events
       (id, operation_id, created_at, expires_at, kind, subject_id, actor_id, outcome, reason,
        delivery_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    id,
    event.operationId ?? null,
    nowMs,
    auditExpiresAtMs(nowMs),
    event.kind,
    event.subjectId,
    event.actorId,
    event.outcome,
    event.reason,
  );
  insertJob(store, {
    operationKey: `log:${id}`,
    kind: 'log_post',
    eventId: id,
    nextRunAt: nowMs,
    nowMs,
  });
}

export type AuditRow = {
  id: string;
  created_at: number;
  expires_at: number;
  kind: string;
  subject_id: string | null;
  actor_id: string | null;
  outcome: string;
  reason: string | null;
  delivery_state: string;
  posted_at: number | null;
  message_ids: string;
  reconcile_cursor: string | null;
};

const AUDIT_COLUMNS = `id, created_at, expires_at, kind, subject_id, actor_id, outcome, reason,
  delivery_state, posted_at, message_ids, reconcile_cursor`;

export function readAuditEvent(store: Store, eventId: string): AuditRow | null {
  return (
    selectOne<AuditRow>(store, `SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE id = ?`, eventId) ??
    null
  );
}

export function parseMessageIds(serialized: string): string[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === 'string');
}

export function markLogPosting(store: Store, eventId: string, nowMs: number): void {
  execute(
    store,
    `UPDATE audit_events SET posted_at = COALESCE(posted_at, ?),
       delivery_state = CASE delivery_state WHEN 'pending' THEN 'posting' ELSE delivery_state END
     WHERE id = ?`,
    nowMs,
    eventId,
  );
}

// late result can only extend an existing row
export function recordLogMessages(
  store: Store,
  eventId: string,
  messageIds: readonly string[],
  nowMs: number,
): void {
  store.transactionSync(() => {
    const event = readAuditEvent(store, eventId);
    if (event === null) return;
    const known = new Set([...parseMessageIds(event.message_ids), ...messageIds]);
    const isErasing = event.delivery_state === 'erasing';
    execute(
      store,
      `UPDATE audit_events SET message_ids = ?, delivery_state = ? WHERE id = ?`,
      JSON.stringify([...known]),
      isErasing ? 'erasing' : 'delivered',
      eventId,
    );
    if (isErasing) enqueueLogDelete(store, eventId, nowMs);
  });
}

// refused attempt created nothing, next try gets a fresh nonce window
export function resetLogPosting(store: Store, eventId: string): void {
  execute(
    store,
    `UPDATE audit_events SET posted_at = NULL, delivery_state = 'pending'
     WHERE id = ? AND delivery_state = 'posting'`,
    eventId,
  );
}

export function setLogDeliveryState(store: Store, eventId: string, state: string): void {
  execute(
    store,
    `UPDATE audit_events SET delivery_state = ?
     WHERE id = ? AND delivery_state NOT IN ('erasing')`,
    state,
    eventId,
  );
}

export function setReconcileCursor(store: Store, eventId: string, cursor: string): void {
  execute(store, 'UPDATE audit_events SET reconcile_cursor = ? WHERE id = ?', cursor, eventId);
}

export function enqueueLogReconcile(store: Store, eventId: string, nowMs: number): void {
  insertJob(store, {
    operationKey: `log-reconcile:${eventId}`,
    kind: 'log_reconcile',
    eventId,
    nextRunAt: nowMs,
    nowMs,
  });
}

// own key, an earlier finished search must not block the one erasure needs
export function enqueueErasureSearch(store: Store, eventId: string, nowMs: number): void {
  insertJob(store, {
    operationKey: `log-reconcile:${eventId}:erasure`,
    kind: 'log_reconcile',
    eventId,
    nextRunAt: nowMs,
    nowMs,
  });
}

export function enqueueLogDelete(store: Store, eventId: string, nowMs: number): void {
  insertJob(store, {
    operationKey: `log-delete:${eventId}`,
    kind: 'log_delete',
    eventId,
    nextRunAt: nowMs,
    nowMs,
    revive: true,
  });
}

export function removeLogMessage(store: Store, eventId: string, messageId: string): void {
  const event = readAuditEvent(store, eventId);
  if (event === null) return;
  const remaining = parseMessageIds(event.message_ids).filter((id) => id !== messageId);
  execute(
    store,
    'UPDATE audit_events SET message_ids = ? WHERE id = ?',
    JSON.stringify(remaining),
    eventId,
  );
}

export function deleteAuditEvent(store: Store, eventId: string): void {
  execute(store, 'DELETE FROM audit_events WHERE id = ?', eventId);
}

export function requestLogSweep(store: Store, nowMs: number): void {
  insertJob(store, {
    operationKey: `log-sweep:${Math.floor(nowMs / 86_400_000)}`,
    kind: 'log_sweep',
    nextRunAt: nowMs,
    nowMs,
  });
}
