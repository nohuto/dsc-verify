import { getGuild } from '../providers/discord-rest';
import type { RestContext, RestOutcome } from '../providers/discord-rest';
import { computeGuildPermissions } from './staff-authority';
import type { RolePermission, StaffActor } from './staff-authority';

type GuildAuthority = {
  readonly guildId: string;
  readonly ownerId: string;
  readonly roles: readonly RolePermission[];
};

export async function readGuildAuthority(
  rest: RestContext,
  guildId: string,
): Promise<RestOutcome<GuildAuthority>> {
  const guild = await getGuild(rest, guildId);
  if (guild.kind !== 'ok') return guild;
  return { kind: 'ok', value: { guildId, ownerId: guild.value.ownerId, roles: guild.value.roles } };
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
