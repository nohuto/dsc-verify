// interaction permissions are per channel and drop to almost nothing during a timeout, only good
// for an early refusal

import { getGuild, getGuildRoles } from '../providers/discord-rest';
import type { RestContext, RestOutcome } from '../providers/discord-rest';
import { computeGuildPermissions } from './staff-authority';
import type { RolePermission, StaffActor } from './staff-authority';

export type GuildAuthority = {
  readonly guildId: string;
  readonly ownerId: string;
  readonly roles: readonly RolePermission[];
};

export async function readGuildAuthority(
  rest: RestContext,
  guildId: string,
): Promise<RestOutcome<GuildAuthority>> {
  const [guild, roles] = await Promise.all([getGuild(rest, guildId), getGuildRoles(rest, guildId)]);
  if (guild.kind !== 'ok') return guild;
  if (roles.kind !== 'ok') return roles;
  return { kind: 'ok', value: { guildId, ownerId: guild.value.ownerId, roles: roles.value } };
}

export function guildStaffActor(
  authority: GuildAuthority,
  userId: string,
  roleIds: readonly string[],
): StaffActor {
  return {
    isOwner: authority.ownerId === userId,
    roleIds,
    permissions: computeGuildPermissions({
      guildId: authority.guildId,
      memberRoleIds: roleIds,
      guildRoles: authority.roles,
    }),
  };
}
