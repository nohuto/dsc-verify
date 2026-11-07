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
  const jobs = selectOne<{ queued: number; oldest: number | null; unresolved: number }>(
    store,
    `SELECT count(*) FILTER (WHERE state IN ('queued', 'running')) AS queued,
       min(next_run_at) FILTER (WHERE state IN ('queued', 'running')) AS oldest,
       count(*) FILTER (WHERE state = 'unresolved') AS unresolved
     FROM jobs`,
  );
  const logs = selectOne<{ total: number }>(
    store,
    `SELECT count(*) AS total FROM audit_events WHERE delivery_state = 'unresolved'`,
  );
  return {
    paused: settings.paused !== 0,
    pauseReason: settings.pause_reason,
    queuedJobs: jobs?.queued ?? 0,
    oldestDueAtMs: jobs?.oldest ?? null,
    unresolvedJobs: jobs?.unresolved ?? 0,
    unresolvedLogEvents: logs?.total ?? 0,
    panelConfigured: settings.panel_message_id !== null,
  };
}
