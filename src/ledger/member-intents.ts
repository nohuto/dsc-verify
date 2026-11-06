import {
  CHALLENGE_FAILURE_WINDOW_MS,
  MAX_CHALLENGE_FAILURES_PER_WINDOW,
} from '../admission/admission-limits';
import type { Store } from './sqlite';
import { execute, selectOne } from './sqlite';

type MemberRow = {
  user_id: string;
  generation: number;
  role_revision: number;
  desired_role: string | null;
  challenge_failures: string;
};

export function selectMember(store: Store, userId: string): MemberRow | undefined {
  return selectOne<MemberRow>(
    store,
    `SELECT user_id, generation, role_revision, desired_role, challenge_failures
     FROM members WHERE user_id = ?`,
    userId,
  );
}

export function ensureMember(store: Store, userId: string, nowMs: number): MemberRow {
  execute(
    store,
    'INSERT INTO members (user_id, updated_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING',
    userId,
    nowMs,
  );
  const member = selectMember(store, userId);
  if (member === undefined) throw new Error('member row is missing');
  return member;
}

export function advanceRoleIntent(
  store: Store,
  userId: string,
  desired: 'present' | 'absent',
  nowMs: number,
): { readonly generation: number; readonly revision: number } {
  const member = ensureMember(store, userId, nowMs);
  const revision = member.role_revision + 1;
  execute(
    store,
    'UPDATE members SET role_revision = ?, desired_role = ?, updated_at = ? WHERE user_id = ?',
    revision,
    desired,
    nowMs,
    userId,
  );
  return { generation: member.generation, revision };
}

export type RoleIntent = {
  readonly generation: number;
  readonly revision: number;
  readonly desired: 'present' | 'absent' | null;
};

export function readRoleIntent(store: Store, userId: string): RoleIntent | null {
  const member = selectMember(store, userId);
  if (member === undefined) return null;
  const desired = member.desired_role;
  return {
    generation: member.generation,
    revision: member.role_revision,
    desired: desired === 'present' || desired === 'absent' ? desired : null,
  };
}

function parseFailureTimes(serialized: string): number[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is number => typeof value === 'number');
}

export function recentFailureTimes(member: MemberRow, nowMs: number): number[] {
  return parseFailureTimes(member.challenge_failures).filter(
    (time) => time > nowMs - CHALLENGE_FAILURE_WINDOW_MS,
  );
}

export function failureLockoutMs(failures: readonly number[], nowMs: number): number | null {
  const oldest = failures[0];
  if (oldest === undefined || failures.length < MAX_CHALLENGE_FAILURES_PER_WINDOW) return null;
  return oldest + CHALLENGE_FAILURE_WINDOW_MS - nowMs;
}
