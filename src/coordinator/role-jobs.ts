import { decideAdmission } from '../admission/admission-rules';
import type { MemberSnapshot } from '../admission/admission-rules';
import { pauseForFault, readSettings } from '../ledger/guild-settings';
import { bindRemovalJoin, finishJob, markMutation, rescheduleJob } from '../ledger/job-queue';
import type { JobRow } from '../ledger/job-queue';
import { readRoleIntent } from '../ledger/member-intents';
import type { RoleIntent } from '../ledger/member-intents';
import {
  abandonGrant,
  confirmGrant,
  readLatestGrant,
  recordRoleOutcome,
  scheduleReconcile,
} from '../ledger/role-intents';
import {
  DISCORD_ERROR_UNKNOWN_ROLE,
  changeMemberRole,
  getGuildMember,
} from '../providers/discord-rest';
import type { RestFailure } from '../providers/discord-rest';
import { guildStaffActor, readGuildAuthority } from '../staff/guild-authority';
import { authorizeStaffAction } from '../staff/staff-authority';
import { deferForRateLimit, deferWithBackoff } from './job-context';
import type { JobContext, JobRunResult } from './job-context';
import {
  MAX_REMOVAL_ATTEMPTS,
  RECONCILE_DELAYS_MS,
  RECONCILE_FIRST_DELAY_MS,
} from './retry-schedule';

const GRANT_AUDIT_REASON = 'Verification passed';
const STAFF_GRANT_AUDIT_REASON = 'Staff approved verification';
const REMOVAL_AUDIT_REASON = 'Staff reset verification';
const RECONCILE_AUDIT_REASON = 'Verification role reconciliation';
const LEGACY_AUDIT_REASON = 'Retired verification role cleanup';

function hasAccessRole(context: JobContext, member: MemberSnapshot): boolean {
  return member.roleIds.includes(context.config.memberRoleId);
}

function isLatestIntent(intent: RoleIntent | null, job: JobRow): intent is RoleIntent {
  return intent !== null && intent.revision === job.role_revision;
}

function roleTarget(context: JobContext, userId: string) {
  return { guildId: context.config.guildId, userId, roleId: context.config.memberRoleId };
}

function pauseForAccessFault(context: JobContext, failure: RestFailure): void {
  const code = failure.kind === 'not_found' ? 'discord_role_missing' : 'discord_access_denied';
  pauseForFault(context.store, code, context.nowMs());
}

function mutationAfter(result: { readonly kind: string }): 'applied' | 'uncertain' | 'none' {
  if (result.kind === 'ok') return 'applied';
  return result.kind === 'uncertain' ? 'uncertain' : 'none';
}

// request may still land after this job is gone, reconciliation watches for it
function carryUncertainty(context: JobContext, job: JobRow, userId: string): void {
  if (job.mutation_state !== 'uncertain') return;
  const nowMs = context.nowMs();
  scheduleReconcile(context.store, {
    userId,
    joinedAtMs: job.joined_at,
    firstRunAt: nowMs + RECONCILE_FIRST_DELAY_MS,
    nowMs,
  });
}

export async function runGrantJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, config, rest } = context;
  const userId = job.user_id;
  if (userId === null) {
    finishJob(store, job, { state: 'cancelled', result: 'invalid', nowMs: context.nowMs() });
    return 'continue';
  }
  carryUncertainty(context, job, userId);

  if (!isLatestIntent(readRoleIntent(store, userId), job)) {
    abandonGrant(store, job, {
      outcome: 'superseded',
      sessionState: 'cancelled',
      nowMs: context.nowMs(),
    });
    return 'continue';
  }

  // authority check goes first, the member snapshot must be fresh when deciding
  if (job.actor_id !== null) {
    const authority = await checkApproverAuthority(context, job.actor_id);
    if (authority === 'denied') {
      abandonGrant(store, job, {
        outcome: 'approver_not_authorized',
        sessionState: 'blocked',
        nowMs: context.nowMs(),
      });
      return 'continue';
    }
    if (authority !== 'allowed') return handleGrantReadFailure(context, job, authority);
  }

  const fetched = await getGuildMember(rest, config.guildId, userId);
  if (fetched.kind !== 'ok') return handleGrantReadFailure(context, job, fetched);
  const member = fetched.value;

  // intent may have changed during the awaits above, read it again before deciding
  const intent = readRoleIntent(store, userId);
  const nowMs = context.nowMs();
  if (!isLatestIntent(intent, job)) {
    abandonGrant(store, job, { outcome: 'superseded', sessionState: 'cancelled', nowMs });
    return 'continue';
  }

  const decision = decideAdmission({
    member,
    accessRoleId: config.memberRoleId,
    punitiveRoleIds: config.punitiveRoleIds,
    paused: readSettings(store).paused !== 0,
    nowMs,
    mode: job.actor_id === null ? 'automatic' : 'staff_override',
    binding: {
      joinedAtMs: job.joined_at ?? member.joinedAtMs,
      generation: job.generation ?? intent.generation,
      currentGeneration: intent.generation,
      deadlineMs: job.deadline_at ?? nowMs,
    },
  });

  switch (decision.outcome) {
    case 'already_admitted':
      return finishConfirmedGrant(context, job, member);
    case 'admit':
      return applyGrant(context, job, member);
    case 'too_young':
      abandonGrant(store, job, { outcome: 'too_young', sessionState: 'blocked', nowMs });
      return 'continue';
    case 'blocked':
      abandonGrant(store, job, {
        outcome: decision.reason,
        sessionState: decision.reason === 'expired' ? 'expired' : 'blocked',
        nowMs,
      });
      return 'continue';
  }
}

async function applyGrant(
  context: JobContext,
  job: JobRow,
  member: MemberSnapshot,
): Promise<JobRunResult> {
  const { store, rest } = context;
  // marker goes first, a crash during the request then recovers as uncertain
  if (!markMutation(store, job, 'in_flight', context.nowMs())) return 'continue';

  const auditReason = job.actor_id === null ? GRANT_AUDIT_REASON : STAFF_GRANT_AUDIT_REASON;
  const result = await changeMemberRole(rest, 'PUT', {
    ...roleTarget(context, member.userId),
    auditReason,
  });
  const nowMs = context.nowMs();
  // erasure or a lease takeover during the request means this job no longer owns the outcome
  if (!markMutation(store, job, mutationAfter(result), nowMs)) return 'continue';

  switch (result.kind) {
    case 'ok': {
      if (!isLatestIntent(readRoleIntent(store, member.userId), job)) {
        scheduleReconcile(store, {
          userId: member.userId,
          joinedAtMs: member.joinedAtMs,
          firstRunAt: nowMs,
          nowMs,
        });
        finishJob(store, job, { state: 'cancelled', result: 'stale_apply', nowMs });
        return 'continue';
      }
      return finishConfirmedGrant(context, job, member);
    }
    case 'uncertain':
      rescheduleJob(store, job, {
        nextRunAt: nowMs + RECONCILE_FIRST_DELAY_MS,
        countAttempt: true,
        nowMs,
      });
      return 'continue';
    case 'rate_limited':
      return deferForRateLimit(context, job, result);
    case 'forbidden':
      pauseForAccessFault(context, result);
      abandonGrant(store, job, { outcome: 'operator_fault', sessionState: 'blocked', nowMs });
      return 'continue';
    case 'not_found':
      if (result.code === DISCORD_ERROR_UNKNOWN_ROLE) pauseForAccessFault(context, result);
      abandonGrant(store, job, {
        outcome: result.code === DISCORD_ERROR_UNKNOWN_ROLE ? 'operator_fault' : 'member_left',
        sessionState: result.code === DISCORD_ERROR_UNKNOWN_ROLE ? 'blocked' : 'cancelled',
        nowMs,
      });
      return 'continue';
    case 'rejected':
    case 'malformed':
    case 'unavailable':
      return deferGrant(context, job);
  }
}

async function finishConfirmedGrant(
  context: JobContext,
  job: JobRow,
  member: MemberSnapshot,
): Promise<JobRunResult> {
  const nowMs = context.nowMs();
  if (!confirmGrant(context.store, job, nowMs)) return 'continue';

  const { legacyRoleId, guildId } = context.config;
  if (legacyRoleId !== null && member.roleIds.includes(legacyRoleId)) {
    await changeMemberRole(context.rest, 'DELETE', {
      guildId,
      userId: member.userId,
      roleId: legacyRoleId,
      auditReason: LEGACY_AUDIT_REASON,
    });
  }
  return 'continue';
}

function handleGrantReadFailure(
  context: JobContext,
  job: JobRow,
  failure: RestFailure,
): JobRunResult {
  const nowMs = context.nowMs();
  switch (failure.kind) {
    case 'not_found':
      abandonGrant(context.store, job, {
        outcome: 'member_left',
        sessionState: 'cancelled',
        nowMs,
      });
      return 'continue';
    case 'forbidden':
      pauseForAccessFault(context, failure);
      abandonGrant(context.store, job, {
        outcome: 'operator_fault',
        sessionState: 'blocked',
        nowMs,
      });
      return 'continue';
    case 'rate_limited':
      if (job.deadline_at !== null && nowMs + failure.retryAfterMs >= job.deadline_at) {
        abandonGrant(context.store, job, { outcome: 'expired', sessionState: 'expired', nowMs });
        return failure.scope === 'route' || failure.scope === 'shared' ? 'continue' : 'stop_batch';
      }
      return deferForRateLimit(context, job, failure);
    case 'rejected':
    case 'unavailable':
    case 'uncertain':
    case 'malformed':
      return deferGrant(context, job);
  }
}

function deferGrant(context: JobContext, job: JobRow): JobRunResult {
  const nowMs = context.nowMs();
  if (job.deadline_at !== null && nowMs >= job.deadline_at) {
    abandonGrant(context.store, job, { outcome: 'expired', sessionState: 'expired', nowMs });
    return 'continue';
  }
  return deferWithBackoff(context, job);
}

// delayed approval must not outlive the authority of its approver
async function checkApproverAuthority(
  context: JobContext,
  actorId: string,
): Promise<'allowed' | 'denied' | RestFailure> {
  const { rest, config } = context;
  const actor = await getGuildMember(rest, config.guildId, actorId);
  if (actor.kind === 'not_found') return 'denied';
  if (actor.kind !== 'ok') return actor;
  const guild = await readGuildAuthority(rest, config.guildId);
  if (guild.kind !== 'ok') return guild;

  const authorization = authorizeStaffAction({
    action: 'approve',
    staffRoleIds: config.staffRoleIds,
    actor: guildStaffActor(guild.value, actorId, actor.value.roleIds),
  });
  return authorization.allowed ? 'allowed' : 'denied';
}

// rejoined member is a different membership, old cleanup must never touch it
function bindJoinOrCancel(context: JobContext, job: JobRow, member: MemberSnapshot): boolean {
  if (job.joined_at === null) {
    bindRemovalJoin(context.store, job, member.joinedAtMs);
    return false;
  }
  if (job.joined_at === member.joinedAtMs) return false;
  recordRoleOutcome(context.store, job, {
    state: 'cancelled',
    result: 'join_changed',
    auditKind: 'possible_late_effect',
    nowMs: context.nowMs(),
  });
  return true;
}

export async function runRemoveJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, config, rest } = context;
  const userId = job.user_id;
  if (userId === null) {
    finishJob(store, job, { state: 'cancelled', result: 'invalid', nowMs: context.nowMs() });
    return 'continue';
  }
  carryUncertainty(context, job, userId);

  if (!isLatestIntent(readRoleIntent(store, userId), job)) {
    finishJob(store, job, { state: 'done', result: 'superseded', nowMs: context.nowMs() });
    return 'continue';
  }

  const fetched = await getGuildMember(rest, config.guildId, userId);
  if (fetched.kind === 'not_found') return recordRemoval(context, job, 'member_left');
  if (fetched.kind !== 'ok') return handleRemovalFailure(context, job, fetched);
  const member = fetched.value;

  if (bindJoinOrCancel(context, job, member)) return 'continue';
  if (!hasAccessRole(context, member)) return recordRemoval(context, job, 'observed_absent');

  if (!isLatestIntent(readRoleIntent(store, userId), job)) {
    finishJob(store, job, { state: 'done', result: 'superseded', nowMs: context.nowMs() });
    return 'continue';
  }
  if (!markMutation(store, job, 'in_flight', context.nowMs())) return 'continue';

  const result = await changeMemberRole(rest, 'DELETE', {
    ...roleTarget(context, userId),
    auditReason: REMOVAL_AUDIT_REASON,
  });
  const nowMs = context.nowMs();
  if (!markMutation(store, job, mutationAfter(result), nowMs)) return 'continue';

  if (result.kind === 'uncertain') {
    scheduleReconcile(store, {
      userId,
      joinedAtMs: member.joinedAtMs,
      firstRunAt: nowMs + RECONCILE_FIRST_DELAY_MS,
      nowMs,
    });
    return handleRemovalFailure(context, job, result);
  }
  if (result.kind !== 'ok') {
    if (result.kind === 'not_found' && result.code !== DISCORD_ERROR_UNKNOWN_ROLE) {
      return recordRemoval(context, job, 'member_left');
    }
    return handleRemovalFailure(context, job, result);
  }

  const observed = await getGuildMember(rest, config.guildId, userId);
  if (observed.kind === 'not_found') return recordRemoval(context, job, 'member_left');
  if (observed.kind !== 'ok') return handleRemovalFailure(context, job, observed);
  return hasAccessRole(context, observed.value)
    ? retryRemoval(context, job)
    : recordRemoval(context, job, 'observed_absent');
}

function retryRemoval(context: JobContext, job: JobRow): JobRunResult {
  if (job.attempts + 1 < MAX_REMOVAL_ATTEMPTS) return deferWithBackoff(context, job);
  recordRoleOutcome(context.store, job, {
    state: 'unresolved',
    result: 'retries_exhausted',
    auditKind: 'reset_unresolved',
    nowMs: context.nowMs(),
  });
  return 'continue';
}

function recordRemoval(context: JobContext, job: JobRow, result: string): JobRunResult {
  recordRoleOutcome(context.store, job, {
    state: 'done',
    result,
    auditKind: 'reset_observed',
    nowMs: context.nowMs(),
  });
  return 'continue';
}

function handleRemovalFailure(
  context: JobContext,
  job: JobRow,
  failure: RestFailure,
): JobRunResult {
  const { store } = context;
  const nowMs = context.nowMs();
  switch (failure.kind) {
    case 'rate_limited':
      return deferForRateLimit(context, job, failure);
    case 'forbidden':
    case 'not_found':
      pauseForAccessFault(context, failure);
      recordRoleOutcome(store, job, {
        state: 'unresolved',
        result: 'operator_fault',
        auditKind: 'reset_unresolved',
        nowMs,
      });
      return 'continue';
    case 'rejected':
    case 'unavailable':
    case 'uncertain':
    case 'malformed':
      return retryRemoval(context, job);
  }
}

// restoring the role is a normal grant, it has to pass the same checks
async function mayRestoreGrant(
  context: JobContext,
  member: MemberSnapshot,
  intent: RoleIntent | null,
): Promise<boolean> {
  const { store, config } = context;
  if (intent === null) return false;
  const grant = readLatestGrant(store, member.userId, intent.revision);
  if (grant === null) return false;
  if (grant.actorId !== null) {
    const authority = await checkApproverAuthority(context, grant.actorId);
    if (authority !== 'allowed') return false;
  }

  // reset or erasure may have landed during the authority check
  const latest = readRoleIntent(store, member.userId);
  if (latest === null || latest.revision !== intent.revision) return false;
  if (readLatestGrant(store, member.userId, intent.revision) === null) return false;
  const decision = decideAdmission({
    member,
    accessRoleId: config.memberRoleId,
    punitiveRoleIds: config.punitiveRoleIds,
    paused: readSettings(store).paused !== 0,
    nowMs: context.nowMs(),
    mode: grant.actorId === null ? 'automatic' : 'staff_override',
    binding: {
      joinedAtMs: member.joinedAtMs,
      generation: intent.generation,
      currentGeneration: latest.generation,
      deadlineMs: grant.deadlineAtMs,
    },
  });
  return decision.outcome === 'admit';
}

// one check of the 5/30/120 second schedule, always uses the latest intent, a later authorized
// grant inherits earlier uncertainty instead of being undone by it
export async function runReconcileJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, config, rest } = context;
  const userId = job.user_id;
  if (userId === null) {
    finishJob(store, job, { state: 'cancelled', result: 'invalid', nowMs: context.nowMs() });
    return 'continue';
  }

  const fetched = await getGuildMember(rest, config.guildId, userId);
  if (fetched.kind === 'not_found') {
    finishJob(store, job, { state: 'done', result: 'member_left', nowMs: context.nowMs() });
    return 'continue';
  }
  if (fetched.kind === 'rate_limited') return deferForRateLimit(context, job, fetched);
  if (fetched.kind !== 'ok') return advanceReconcile(context, job, false);
  const member = fetched.value;

  if (bindJoinOrCancel(context, job, member)) return 'continue';

  const intent = readRoleIntent(store, userId);
  const desired = intent?.desired ?? null;
  const hasRole = hasAccessRole(context, member);
  if (desired === null) return advanceReconcile(context, job, !hasRole);
  if (hasRole === (desired === 'present')) return advanceReconcile(context, job, true);

  if (desired === 'present' && !(await mayRestoreGrant(context, member, intent))) {
    return advanceReconcile(context, job, false);
  }

  // compensation happens only after the fresh membership, join and latest-intent checks above
  if (!markMutation(store, job, 'in_flight', context.nowMs())) return 'continue';
  const compensation = await changeMemberRole(rest, desired === 'absent' ? 'DELETE' : 'PUT', {
    ...roleTarget(context, userId),
    auditReason: RECONCILE_AUDIT_REASON,
  });
  if (!markMutation(store, job, mutationAfter(compensation), context.nowMs())) return 'continue';
  if (compensation.kind === 'rate_limited') return deferForRateLimit(context, job, compensation);

  const observed = await getGuildMember(rest, config.guildId, userId);
  const matches =
    observed.kind === 'ok' && hasAccessRole(context, observed.value) === (desired === 'present');
  return advanceReconcile(context, job, matches);
}

function advanceReconcile(context: JobContext, job: JobRow, matches: boolean): JobRunResult {
  const { store } = context;
  const nowMs = context.nowMs();
  const nextDelay = RECONCILE_DELAYS_MS[job.attempts + 1];

  if (nextDelay !== undefined) {
    rescheduleJob(store, job, {
      nextRunAt: Math.max(job.created_at + nextDelay, nowMs),
      countAttempt: true,
      nowMs,
    });
    return 'continue';
  }

  if (matches) {
    finishJob(store, job, { state: 'done', result: 'observed', nowMs });
    return 'continue';
  }
  recordRoleOutcome(store, job, {
    state: 'unresolved',
    result: 'role_mismatch',
    auditKind: 'role_unresolved',
    nowMs,
  });
  return 'continue';
}
