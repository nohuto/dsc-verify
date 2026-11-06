// callers pass trusted snapshots and explicit time

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

export const MINIMUM_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const MEMBER_FLAG_IS_GUEST = 1 << 4;

const MEMBER_FLAG_AUTOMOD_QUARANTINED_USERNAME = 1 << 7;

const MEMBER_FLAG_AUTOMOD_QUARANTINED_GUILD_TAG = 1 << 10;

export type MemberSnapshot = {
  readonly userId: string;
  readonly isBot: boolean;
  readonly joinedAtMs: number;
  readonly roleIds: readonly string[];
  readonly pending: boolean;
  readonly timeoutUntilMs: number | null;
  readonly flags: number;
};

export type AdmissionBlockReason =
  | 'bot_account'
  | 'guest_member'
  | 'pending_screening'
  | 'timed_out'
  | 'punitive_role'
  | 'quarantined'
  | 'paused'
  | 'join_changed'
  | 'generation_changed'
  | 'expired';

export type AdmissionDecision =
  | { readonly outcome: 'admit' }
  | { readonly outcome: 'already_admitted' }
  | { readonly outcome: 'too_young'; readonly eligibleAtMs: number }
  | { readonly outcome: 'blocked'; readonly reason: AdmissionBlockReason };

// set once admission work was accepted, later snapshots are compared against it
export type AdmissionBinding = {
  readonly joinedAtMs: number;
  readonly generation: number;
  readonly currentGeneration: number;
  readonly deadlineMs: number;
};

export type AdmissionInput = {
  readonly member: MemberSnapshot;
  readonly accessRoleId: string;
  readonly punitiveRoleIds: readonly string[];
  readonly paused: boolean;
  readonly nowMs: number;
  readonly mode: 'automatic' | 'staff_override';
  readonly binding?: AdmissionBinding;
};

export function accountCreatedAtMs(userId: string): number {
  return Number((BigInt(userId) >> SNOWFLAKE_TIMESTAMP_SHIFT) + DISCORD_EPOCH_MS);
}

export function accountEligibleAtMs(userId: string): number {
  return accountCreatedAtMs(userId) + MINIMUM_ACCOUNT_AGE_MS;
}

export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const { member, nowMs, binding, mode } = input;

  if (binding !== undefined) {
    if (member.joinedAtMs !== binding.joinedAtMs) return blocked('join_changed');
    if (binding.generation !== binding.currentGeneration) return blocked('generation_changed');
    if (nowMs >= binding.deadlineMs) return blocked('expired');
  }

  if (member.roleIds.includes(input.accessRoleId)) return { outcome: 'already_admitted' };
  if (member.isBot) return blocked('bot_account');
  if ((member.flags & MEMBER_FLAG_IS_GUEST) !== 0) return blocked('guest_member');
  if (member.pending) return blocked('pending_screening');
  if (member.timeoutUntilMs !== null && member.timeoutUntilMs > nowMs) return blocked('timed_out');
  if (member.roleIds.some((roleId) => input.punitiveRoleIds.includes(roleId))) {
    return blocked('punitive_role');
  }
  if (isQuarantined(member.flags)) return blocked('quarantined');

  // staff approval bypasses account age and the challenge only, every restriction above still holds
  if (mode === 'staff_override') return { outcome: 'admit' };

  if (input.paused) return blocked('paused');

  const eligibleAtMs = accountEligibleAtMs(member.userId);
  return nowMs >= eligibleAtMs ? { outcome: 'admit' } : { outcome: 'too_young', eligibleAtMs };
}

function blocked(reason: AdmissionBlockReason): AdmissionDecision {
  return { outcome: 'blocked', reason };
}

function isQuarantined(flags: number): boolean {
  const quarantineMask =
    MEMBER_FLAG_AUTOMOD_QUARANTINED_USERNAME | MEMBER_FLAG_AUTOMOD_QUARANTINED_GUILD_TAG;
  return (flags & quarantineMask) !== 0;
}
