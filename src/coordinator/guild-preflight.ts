// shared by the node preflight tool and the worker, callers supply a fresh snapshot

import type { AppConfig } from '../deployment-config';
import type { ChannelOverwrite, ChannelSummary, RoleSummary } from '../providers/discord-rest';

const PERMISSION_KICK_MEMBERS = 1n << 1n;
const PERMISSION_BAN_MEMBERS = 1n << 2n;
const PERMISSION_ADMINISTRATOR = 1n << 3n;
const PERMISSION_MANAGE_CHANNELS = 1n << 4n;
const PERMISSION_MANAGE_GUILD = 1n << 5n;
const PERMISSION_VIEW_CHANNEL = 1n << 10n;
const PERMISSION_SEND_MESSAGES = 1n << 11n;
const PERMISSION_MANAGE_MESSAGES = 1n << 13n;
const PERMISSION_EMBED_LINKS = 1n << 14n;
const PERMISSION_READ_MESSAGE_HISTORY = 1n << 16n;
const PERMISSION_MENTION_EVERYONE = 1n << 17n;
const PERMISSION_MANAGE_ROLES = 1n << 28n;
const PERMISSION_MANAGE_WEBHOOKS = 1n << 29n;
const PERMISSION_MODERATE_MEMBERS = 1n << 40n;

const ALL_PERMISSIONS = (1n << 64n) - 1n;

const DANGEROUS_MEMBER_ROLE_PERMISSIONS =
  PERMISSION_ADMINISTRATOR |
  PERMISSION_MANAGE_GUILD |
  PERMISSION_MANAGE_ROLES |
  PERMISSION_MANAGE_CHANNELS |
  PERMISSION_MANAGE_WEBHOOKS |
  PERMISSION_BAN_MEMBERS |
  PERMISSION_KICK_MEMBERS |
  PERMISSION_MANAGE_MESSAGES |
  PERMISSION_MODERATE_MEMBERS |
  PERMISSION_MENTION_EVERYONE;

const EXCESS_BOT_PERMISSIONS =
  PERMISSION_BAN_MEMBERS |
  PERMISSION_KICK_MEMBERS |
  PERMISSION_MANAGE_CHANNELS |
  PERMISSION_MANAGE_MESSAGES;

const VERIFICATION_CHANNEL_PERMISSIONS =
  PERMISSION_VIEW_CHANNEL | PERMISSION_SEND_MESSAGES | PERMISSION_EMBED_LINKS;
const LOG_CHANNEL_PERMISSIONS = VERIFICATION_CHANNEL_PERMISSIONS | PERMISSION_READ_MESSAGE_HISTORY;

const OVERWRITE_ROLE = 0;
const OVERWRITE_MEMBER = 1;

export type PreflightRole = RoleSummary;
export type PreflightOverwrite = ChannelOverwrite;
export type PreflightChannel = ChannelSummary;

export type PreflightConfig = Pick<
  AppConfig,
  'applicationId' | 'guildId' | 'memberRoleId' | 'staffRoleIds' | 'punitiveRoleIds' | 'legacyRoleId'
>;

export type PreflightSnapshot = {
  readonly botUserId: string;
  readonly botRoleIds: readonly string[];
  readonly guildOwnerId: string;
  readonly guildRequiresMfa: boolean;
  readonly roles: readonly PreflightRole[];
  readonly verificationChannel: PreflightChannel | null;
  readonly logChannel: PreflightChannel | null;
};

export type PreflightFinding = {
  readonly code: string;
  readonly severity: 'error' | 'warning';
};

function error(code: string): PreflightFinding {
  return { code, severity: 'error' };
}

function warning(code: string): PreflightFinding {
  return { code, severity: 'warning' };
}

function hasAllPermissions(permissions: bigint, required: bigint): boolean {
  return (permissions & required) === required;
}

function computeBasePermissions(
  guildId: string,
  roleIds: readonly string[],
  roles: readonly PreflightRole[],
): bigint {
  let permissions = 0n;
  for (const role of roles) {
    if (role.id === guildId || roleIds.includes(role.id)) permissions |= role.permissions;
  }
  return (permissions & PERMISSION_ADMINISTRATOR) !== 0n ? ALL_PERMISSIONS : permissions;
}

// follows the order discord documents, owner status is not part of this input, see isBotOwner
export function computeChannelPermissions(options: {
  guildId: string;
  userId: string;
  roleIds: readonly string[];
  roles: readonly PreflightRole[];
  channel: PreflightChannel;
}): bigint {
  const { guildId, userId, roleIds, roles, channel } = options;

  const base = computeBasePermissions(guildId, roleIds, roles);
  if ((base & PERMISSION_ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  let permissions = base;
  const everyone = channel.overwrites.find(
    (overwrite) => overwrite.type === OVERWRITE_ROLE && overwrite.id === guildId,
  );
  if (everyone !== undefined) permissions = (permissions & ~everyone.deny) | everyone.allow;

  // role overwrites are merged first, an allow beats a deny whatever the role position
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of channel.overwrites) {
    const isMemberRole = overwrite.id !== guildId && roleIds.includes(overwrite.id);
    if (overwrite.type === OVERWRITE_ROLE && isMemberRole) {
      allow |= overwrite.allow;
      deny |= overwrite.deny;
    }
  }
  permissions = (permissions & ~deny) | allow;

  const member = channel.overwrites.find(
    (overwrite) => overwrite.type === OVERWRITE_MEMBER && overwrite.id === userId,
  );
  return member === undefined ? permissions : (permissions & ~member.deny) | member.allow;
}

function isBotOwner(snapshot: PreflightSnapshot): boolean {
  return snapshot.botUserId === snapshot.guildOwnerId;
}

function botChannelPermissions(
  config: PreflightConfig,
  snapshot: PreflightSnapshot,
  channel: PreflightChannel,
): bigint {
  if (isBotOwner(snapshot)) return ALL_PERMISSIONS;
  return computeChannelPermissions({
    guildId: config.guildId,
    userId: snapshot.botUserId,
    roleIds: snapshot.botRoleIds,
    roles: snapshot.roles,
    channel,
  });
}

function everyoneCanView(
  config: PreflightConfig,
  snapshot: PreflightSnapshot,
  channel: PreflightChannel,
): boolean {
  const permissions = computeChannelPermissions({
    guildId: config.guildId,
    userId: '',
    roleIds: [],
    roles: snapshot.roles,
    channel,
  });
  return (permissions & PERMISSION_VIEW_CHANNEL) !== 0n;
}

function checkRoles(config: PreflightConfig, snapshot: PreflightSnapshot): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const knownRoleIds = new Set(snapshot.roles.map((role) => role.id));
  const { memberRoleId, staffRoleIds, punitiveRoleIds, legacyRoleId } = config;

  const memberRole = snapshot.roles.find((role) => role.id === memberRoleId);
  if (memberRole === undefined) {
    findings.push(error('member_role_missing'));
  } else {
    if (memberRole.managed) findings.push(error('member_role_managed'));
    if ((memberRole.permissions & DANGEROUS_MEMBER_ROLE_PERMISSIONS) !== 0n) {
      findings.push(error('member_role_dangerous_permissions'));
    }
  }

  if (staffRoleIds.some((id) => !knownRoleIds.has(id))) findings.push(error('staff_role_missing'));
  if (punitiveRoleIds.some((id) => !knownRoleIds.has(id))) {
    findings.push(error('punitive_role_missing'));
  }
  if (legacyRoleId !== null && !knownRoleIds.has(legacyRoleId)) {
    findings.push(error('legacy_role_missing'));
  }

  if (staffRoleIds.includes(memberRoleId)) findings.push(error('member_role_is_staff'));
  if (punitiveRoleIds.includes(memberRoleId)) findings.push(error('member_role_is_punitive'));
  if (legacyRoleId === memberRoleId) findings.push(error('member_role_is_legacy'));
  if (legacyRoleId !== null && punitiveRoleIds.includes(legacyRoleId)) {
    findings.push(error('legacy_role_is_punitive'));
  }

  return findings;
}

function botPosition(snapshot: PreflightSnapshot): number {
  if (isBotOwner(snapshot)) return Number.POSITIVE_INFINITY;
  // every member holds @everyone, which is at pos 0
  let highest = 0;
  for (const role of snapshot.roles) {
    if (snapshot.botRoleIds.includes(role.id)) highest = Math.max(highest, role.position);
  }
  return highest;
}

function checkBotAuthority(
  config: PreflightConfig,
  snapshot: PreflightSnapshot,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  const permissions = isBotOwner(snapshot)
    ? ALL_PERMISSIONS
    : computeBasePermissions(config.guildId, snapshot.botRoleIds, snapshot.roles);
  if ((permissions & PERMISSION_MANAGE_ROLES) === 0n) {
    findings.push(error('bot_missing_manage_roles'));
  }
  if ((permissions & PERMISSION_ADMINISTRATOR) !== 0n) {
    findings.push(warning('bot_administrator'));
  } else if ((permissions & EXCESS_BOT_PERMISSIONS) !== 0n) {
    findings.push(warning('bot_excess_permissions'));
  }

  const position = botPosition(snapshot);
  const positionOf = (roleId: string | null): number | undefined =>
    snapshot.roles.find((role) => role.id === roleId)?.position;
  const isManageable = (roleId: string | null): boolean => {
    const rolePosition = positionOf(roleId);
    return rolePosition === undefined || position > rolePosition;
  };
  const isOutranked = (roleId: string): boolean => {
    const rolePosition = positionOf(roleId);
    return rolePosition !== undefined && position > rolePosition;
  };

  if (!isManageable(config.memberRoleId)) findings.push(error('bot_below_member_role'));
  if (!isManageable(config.legacyRoleId)) findings.push(error('bot_below_legacy_role'));
  if (config.staffRoleIds.some(isOutranked)) findings.push(warning('bot_above_staff_role'));
  if (config.punitiveRoleIds.some(isOutranked)) findings.push(warning('bot_above_punitive_role'));

  return findings;
}

function checkVerificationChannel(
  config: PreflightConfig,
  snapshot: PreflightSnapshot,
): PreflightFinding[] {
  const channel = snapshot.verificationChannel;
  if (channel === null) return [error('verification_channel_missing')];
  if (channel.guildId !== config.guildId) return [error('verification_channel_wrong_guild')];

  const findings: PreflightFinding[] = [];
  const permissions = botChannelPermissions(config, snapshot, channel);
  if (!hasAllPermissions(permissions, VERIFICATION_CHANNEL_PERMISSIONS)) {
    findings.push(error('verification_channel_bot_permissions'));
  }
  if (!everyoneCanView(config, snapshot, channel)) {
    findings.push(warning('verification_channel_hidden'));
  }
  return findings;
}

function checkLogChannel(config: PreflightConfig, snapshot: PreflightSnapshot): PreflightFinding[] {
  const channel = snapshot.logChannel;
  if (channel === null) return [error('log_channel_missing')];
  if (channel.guildId !== config.guildId) return [error('log_channel_wrong_guild')];

  const findings: PreflightFinding[] = [];
  const permissions = botChannelPermissions(config, snapshot, channel);
  if (!hasAllPermissions(permissions, LOG_CHANNEL_PERMISSIONS)) {
    findings.push(error('log_channel_bot_permissions'));
  }
  if (everyoneCanView(config, snapshot, channel)) findings.push(error('log_channel_public'));
  return findings;
}

function checkIdentity(config: PreflightConfig, snapshot: PreflightSnapshot): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  // log copies are found by their author, which must be the bot user of this application
  if (snapshot.botUserId !== config.applicationId) findings.push(error('bot_user_not_application'));
  // with serverwide 2FA, discord refuses manage roles unless the app owner account uses 2FA
  if (snapshot.guildRequiresMfa) findings.push(warning('guild_requires_owner_2fa'));
  return findings;
}

export function evaluatePreflight(
  config: PreflightConfig,
  snapshot: PreflightSnapshot,
): readonly PreflightFinding[] {
  return [
    ...checkIdentity(config, snapshot),
    ...checkRoles(config, snapshot),
    ...checkBotAuthority(config, snapshot),
    ...checkVerificationChannel(config, snapshot),
    ...checkLogChannel(config, snapshot),
  ];
}

export function hasPreflightErrors(findings: readonly PreflightFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}
