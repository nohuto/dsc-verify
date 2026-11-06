import { hasOperation, insertAuditEvent } from './audit-ledger';
import type { StaffCommandResult } from './audit-ledger';
import { insertJob } from './job-queue';
import type { Store } from './sqlite';
import { execute, selectOne } from './sqlite';

type SettingsRow = {
  paused: number;
  pause_reason: string | null;
  // bumped by every pause or resume, a slow resume uses it to detect a newer pause
  pause_revision: number;
  panel_channel_id: string | null;
  panel_message_id: string | null;
  discord_blocked_until: number;
  next_cleanup_at: number | null;
  sweep_cursor: string | null;
};

export function readSettings(store: Store): SettingsRow {
  const settings = selectOne<SettingsRow>(
    store,
    `SELECT paused, pause_reason, pause_revision, panel_channel_id, panel_message_id,
            discord_blocked_until, next_cleanup_at, sweep_cursor
     FROM settings WHERE id = 1`,
  );
  if (settings === undefined) throw new Error('settings row is missing');
  return settings;
}

export function setPaused(
  store: Store,
  input: {
    readonly operationId: string;
    readonly actorId: string | null;
    readonly paused: boolean;
    readonly reason: string | null;
    readonly nowMs: number;
  },
): StaffCommandResult {
  return store.transactionSync(() => {
    if (hasOperation(store, input.operationId)) return { kind: 'duplicate' };
    execute(
      store,
      `UPDATE settings SET paused = ?, pause_reason = ?, pause_revision = pause_revision + 1
       WHERE id = 1`,
      input.paused ? 1 : 0,
      input.paused ? input.reason : null,
    );
    insertAuditEvent(
      store,
      {
        kind: input.paused ? 'verification_paused' : 'verification_resumed',
        subjectId: null,
        actorId: input.actorId,
        outcome: input.paused ? 'paused' : 'resumed',
        reason: input.reason,
        operationId: input.operationId,
      },
      input.nowMs,
    );
    return { kind: 'queued' };
  });
}

// pauses once per fault, stops a bad token or deleted role from hot looping
export function pauseForFault(store: Store, code: string, nowMs: number): void {
  store.transactionSync(() => {
    if (readSettings(store).paused !== 0) return;
    execute(
      store,
      `UPDATE settings SET paused = 1, pause_reason = ?, pause_revision = pause_revision + 1
       WHERE id = 1`,
      code,
    );
    insertAuditEvent(
      store,
      { kind: 'operator_fault', subjectId: null, actorId: null, outcome: code, reason: null },
      nowMs,
    );
  });
}

export function requestPanel(
  store: Store,
  input: { readonly operationId: string; readonly channelId: string; readonly nowMs: number },
): StaffCommandResult {
  const inserted = insertJob(store, {
    operationKey: `panel:${input.operationId}`,
    kind: 'panel',
    payload: input.channelId,
    nextRunAt: input.nowMs,
    nowMs: input.nowMs,
  });
  return inserted ? { kind: 'queued' } : { kind: 'duplicate' };
}

export function recordPanel(store: Store, channelId: string, messageId: string): void {
  execute(
    store,
    'UPDATE settings SET panel_channel_id = ?, panel_message_id = ? WHERE id = 1',
    channelId,
    messageId,
  );
}

export function setDiscordBlockedUntil(store: Store, untilMs: number): void {
  execute(store, 'UPDATE settings SET discord_blocked_until = ? WHERE id = 1', untilMs);
}

export function setSweepCursor(store: Store, cursor: string | null): void {
  execute(store, 'UPDATE settings SET sweep_cursor = ? WHERE id = 1', cursor);
}

export function ensureCleanupScheduled(store: Store, nextCleanupAt: number): void {
  execute(
    store,
    'UPDATE settings SET next_cleanup_at = ? WHERE id = 1 AND next_cleanup_at IS NULL',
    nextCleanupAt,
  );
}

export function setNextCleanupAt(store: Store, nextCleanupAt: number | null): void {
  execute(store, 'UPDATE settings SET next_cleanup_at = ? WHERE id = 1', nextCleanupAt);
}
