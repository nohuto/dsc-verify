import type { MemberSnapshot } from '../admission/admission-rules';
import { bits, id, record, timestamp } from './discord-fields';

export type InteractionMember = MemberSnapshot & { readonly permissions: bigint };

export type ResolvedTarget = {
  readonly userId: string;
  readonly member: InteractionMember | null;
};

type InteractionBase = {
  readonly id: string;
  readonly applicationId: string;
  readonly token: string;
  readonly guildId: string | null;
  readonly context: number | null;
  readonly guildInstallOwner: string | null;
  readonly member: InteractionMember | null;
};

export type CommandInteraction = InteractionBase & {
  readonly type: 'command';
  readonly commandName: string;
  readonly subcommand: string | null;
  readonly options: ReadonlyMap<string, string>;
  readonly targets: ReadonlyMap<string, ResolvedTarget>;
};

export type ComponentInteraction = InteractionBase & {
  readonly type: 'component';
  readonly customId: string;
};

export type Interaction =
  | { readonly type: 'ping' }
  | CommandInteraction
  | ComponentInteraction
  | { readonly type: 'unsupported' };

function user(value: unknown): { userId: string; isBot: boolean } | null {
  if (!record(value) || !id(value['id'])) return null;
  if ('bot' in value && typeof value['bot'] !== 'boolean') return null;
  return { userId: value['id'], isBot: value['bot'] === true };
}

function memberFields(
  value: Record<string, unknown>,
  identity: { userId: string; isBot: boolean },
): MemberSnapshot | null {
  const joinedAtMs = timestamp(value['joined_at']);
  const roles = value['roles'];
  if (joinedAtMs === null || !Array.isArray(roles)) return null;
  const roleIds: string[] = [];
  for (const role of roles) {
    if (!id(role)) return null;
    roleIds.push(role);
  }
  if ('pending' in value && typeof value['pending'] !== 'boolean') return null;
  let timeoutUntilMs: number | null = null;
  if ('communication_disabled_until' in value && value['communication_disabled_until'] !== null) {
    timeoutUntilMs = timestamp(value['communication_disabled_until']);
    if (timeoutUntilMs === null) return null;
  }
  let flags = 0;
  if ('flags' in value) {
    const supplied = value['flags'];
    if (typeof supplied !== 'number' || !Number.isSafeInteger(supplied) || supplied < 0)
      return null;
    flags = supplied;
  }
  return {
    userId: identity.userId,
    isBot: identity.isBot,
    joinedAtMs,
    roleIds,
    pending: value['pending'] === true,
    timeoutUntilMs,
    flags,
  };
}

export function decodeMember(value: unknown): MemberSnapshot | null {
  if (!record(value)) return null;
  const identity = user(value['user']);
  return identity === null ? null : memberFields(value, identity);
}

function interactionMember(
  value: unknown,
  identity: { userId: string; isBot: boolean } | null,
): InteractionMember | null {
  if (!record(value) || identity === null) return null;
  const snapshot = memberFields(value, identity);
  const permissions = bits(value['permissions']);
  return snapshot === null || permissions === null ? null : { ...snapshot, permissions };
}

export function optionalId(value: Record<string, unknown>, key: string): string | null | false {
  if (!(key in value) || value[key] === null) return null;
  return id(value[key]) ? value[key] : false;
}

function decodeTargets(value: unknown): ReadonlyMap<string, ResolvedTarget> | null {
  const targets = new Map<string, ResolvedTarget>();
  if (value === undefined) return targets;
  if (!record(value)) return null;
  const users = value['users'];
  const members = value['members'];
  if ('users' in value && !record(users)) return null;
  if ('members' in value && !record(members)) return null;
  if (record(users)) {
    for (const [key, rawUser] of Object.entries(users)) {
      const identity = user(rawUser);
      if (!id(key) || identity === null || identity.userId !== key) return null;
      let member: InteractionMember | null = null;
      if (record(members) && Object.hasOwn(members, key)) {
        member = interactionMember(members[key], identity);
        if (member === null) return null;
      }
      targets.set(key, { userId: identity.userId, member });
    }
  }
  if (record(members)) {
    for (const key of Object.keys(members)) {
      if (!targets.has(key)) return null;
    }
  }
  return targets;
}

function decodeOptions(
  value: unknown,
): { subcommand: string | null; options: ReadonlyMap<string, string> } | null {
  const options = new Map<string, string>();
  if (value === undefined) return { subcommand: null, options };
  if (!Array.isArray(value)) return null;
  let entries: unknown[] = value;
  let subcommand: string | null = null;
  const first: unknown = value[0];
  if (record(first) && first['type'] === 1) {
    if (value.length !== 1 || typeof first['name'] !== 'string' || first['name'].length === 0)
      return null;
    subcommand = first['name'];
    if ('options' in first && !Array.isArray(first['options'])) return null;
    entries = Array.isArray(first['options']) ? first['options'] : [];
  }
  for (const entry of entries) {
    if (!record(entry) || typeof entry['name'] !== 'string' || entry['name'].length === 0)
      return null;
    const name = entry['name'];
    const optionValue = entry['value'];
    const type = entry['type'];
    if (options.has(name) || typeof optionValue !== 'string') return null;
    if (type !== 3 && type !== 6 && type !== 7) return null;
    if ((type === 6 || type === 7) && !id(optionValue)) return null;
    options.set(name, optionValue);
  }
  return { subcommand, options };
}

export function decodeInteraction(value: unknown): Interaction | null {
  if (!record(value) || !id(value['id']) || !id(value['application_id'])) return null;
  const type = value['type'];
  if (typeof type !== 'number' || !Number.isSafeInteger(type)) return null;
  if (type === 1) return { type: 'ping' };
  if (type !== 2 && type !== 3) return { type: 'unsupported' };
  if (typeof value['token'] !== 'string' || value['token'].length === 0) return null;
  const guildId = optionalId(value, 'guild_id');
  if (guildId === false || optionalId(value, 'channel_id') === false) return null;
  const context: unknown = 'context' in value ? value['context'] : null;
  if (context !== null && context !== 0 && context !== 1 && context !== 2) return null;
  let guildInstallOwner: string | null = null;
  if ('authorizing_integration_owners' in value) {
    const owners = value['authorizing_integration_owners'];
    if (!record(owners)) return null;
    // "0" marks a DM with the bot user, which no guild installation authorized
    const guildOwner = owners['0'] === '0' ? null : optionalId(owners, '0');
    if (guildOwner === false) return null;
    guildInstallOwner = guildOwner;
  }
  let member: InteractionMember | null = null;
  if ('member' in value) {
    const rawMember = value['member'];
    member = interactionMember(rawMember, record(rawMember) ? user(rawMember['user']) : null);
    if (member === null) return null;
  }
  const base: InteractionBase = {
    id: value['id'],
    applicationId: value['application_id'],
    token: value['token'],
    guildId,
    context,
    guildInstallOwner,
    member,
  };
  const data = value['data'];
  if (!record(data)) return null;
  if (type === 3) {
    return typeof data['custom_id'] === 'string' && data['custom_id'].length > 0
      ? { ...base, type: 'component', customId: data['custom_id'] }
      : null;
  }
  if (typeof data['name'] !== 'string' || data['name'].length === 0) return null;
  const decodedOptions = decodeOptions(data['options']);
  const targets = decodeTargets(data['resolved']);
  if (decodedOptions === null || targets === null) return null;
  return {
    ...base,
    type: 'command',
    commandName: data['name'],
    subcommand: decodedOptions.subcommand,
    options: decodedOptions.options,
    targets,
  };
}
