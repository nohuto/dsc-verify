// nothing here may write

import { readSettings } from './guild-settings';
import { selectMember } from './member-intents';
import type { Store } from './sqlite';
import { selectOne } from './sqlite';

export type MemberStatus = {
  readonly generation: number | null;
  readonly desiredRole: string | null;
  readonly sessionState: string | null;
  readonly latestRoleJob: {
    readonly kind: string;
    readonly state: string;
    readonly result: string | null;
  } | null;
};

export function readMemberStatus(store: Store, userId: string): MemberStatus {
  const member = selectMember(store, userId);
  const session = selectOne<{ state: string }>(
    store,
    'SELECT state FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    userId,
  );
  const job = selectOne<{ kind: string; state: string; result: string | null }>(
    store,
    `SELECT kind, state, result FROM jobs
     WHERE user_id = ? AND kind IN ('grant', 'remove', 'reconcile')
     ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  return {
    generation: member?.generation ?? null,
    desiredRole: member?.desired_role ?? null,
    sessionState: session?.state ?? null,
    latestRoleJob: job ?? null,
  };
}

export type ConfigurationStatus = {
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly queuedJobs: number;
  readonly oldestDueAtMs: number | null;
  readonly unresolvedJobs: number;
  readonly unresolvedLogEvents: number;
  readonly panelConfigured: boolean;
};

export function readConfigurationStatus(store: Store): ConfigurationStatus {
  const settings = readSettings(store);
  const queue = selectOne<{ queued: number; oldest: number | null }>(
    store,
    `SELECT count(*) AS queued, min(next_run_at) AS oldest FROM jobs
     WHERE state IN ('queued', 'running')`,
  );
  const unresolved = selectOne<{ total: number }>(
    store,
    `SELECT count(*) AS total FROM jobs WHERE state = 'unresolved'`,
  );
  const logs = selectOne<{ total: number }>(
    store,
    `SELECT count(*) AS total FROM audit_events WHERE delivery_state = 'unresolved'`,
  );
  return {
    paused: settings.paused !== 0,
    pauseReason: settings.pause_reason,
    queuedJobs: queue?.queued ?? 0,
    oldestDueAtMs: queue?.oldest ?? null,
    unresolvedJobs: unresolved?.total ?? 0,
    unresolvedLogEvents: logs?.total ?? 0,
    panelConfigured: settings.panel_message_id !== null,
  };
}
