const PERMISSION_ADMINISTRATOR = 1n << 3n;

const PERMISSION_MANAGE_GUILD = 1n << 5n;

export type StaffAction =
  | 'panel'
  | 'status_configuration'
  | 'status_member'
  | 'approve'
  | 'reset'
  | 'pause'
  | 'resume'
  | 'delete_data';

const STAFF_ROLE_ACTIONS: ReadonlySet<StaffAction> = new Set<StaffAction>([
  'status_member',
  'approve',
  'reset',
]);

export type StaffActor = {
  readonly isOwner: boolean;
  readonly permissions: bigint;
  readonly roleIds: readonly string[];
};

type StaffAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'forbidden' | 'protected_target' };

type StaffAuthorizationInput = {
  readonly action: StaffAction;
  readonly actor: StaffActor;
  readonly staffRoleIds: readonly string[];
  // reset removes shared access, role only staff cant use it on management or peers
  readonly target?: StaffActor;
};

export function hasManagementAuthority(actor: StaffActor): boolean {
  const managementBits = PERMISSION_ADMINISTRATOR | PERMISSION_MANAGE_GUILD;
  return actor.isOwner || (actor.permissions & managementBits) !== 0n;
}

function hasStaffRole(actor: StaffActor, staffRoleIds: readonly string[]): boolean {
  return actor.roleIds.some((roleId) => staffRoleIds.includes(roleId));
}

export function authorizeStaffAction(input: StaffAuthorizationInput): StaffAuthorization {
  const { action, actor, staffRoleIds, target } = input;
  const isManagement = hasManagementAuthority(actor);

  if (!isManagement && !(STAFF_ROLE_ACTIONS.has(action) && hasStaffRole(actor, staffRoleIds))) {
    return { allowed: false, reason: 'forbidden' };
  }

  if (action === 'reset' && target !== undefined && !isManagement) {
    if (hasManagementAuthority(target) || hasStaffRole(target, staffRoleIds)) {
      return { allowed: false, reason: 'protected_target' };
    }
  }

  return { allowed: true };
}

export type RolePermission = {
  readonly id: string;
  readonly permissions: bigint;
};

// @everyone role shares the guild ID and applies to every member
export function computeGuildPermissions(input: {
  readonly guildId: string;
  readonly memberRoleIds: readonly string[];
  readonly guildRoles: readonly RolePermission[];
}): bigint {
  let permissions = 0n;
  for (const role of input.guildRoles) {
    if (role.id === input.guildId || input.memberRoleIds.includes(role.id)) {
      permissions |= role.permissions;
    }
  }
  return permissions;
}
