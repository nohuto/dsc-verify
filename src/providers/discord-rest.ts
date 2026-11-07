import type { MemberSnapshot } from '../admission/admission-rules';
import { bits, id, record } from './discord-fields';
import { decodeMember, optionalId } from './discord-interactions';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

export const UPSTREAM_TIMEOUT_MS = 8000;

export const DISCORD_ERROR_UNKNOWN_ROLE = 10011;

export const USER_AGENT = 'DiscordBot (https://github.com/nohuto/dsc-verify, 0.1.0)';

export type RestFailure =
  | { readonly kind: 'not_found'; readonly code: number | null }
  | { readonly kind: 'forbidden'; readonly status: 401 | 403 }
  | { readonly kind: 'rejected'; readonly status: number }
  | {
      readonly kind: 'rate_limited';
      readonly retryAfterMs: number;
      readonly scope: 'route' | 'global' | 'shared' | 'edge';
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'malformed' };

export type RestOutcome<T> = { readonly kind: 'ok'; readonly value: T } | RestFailure;

export type RestContext = { readonly botToken: string; readonly timeoutMs?: number };

export type GuildSummary = { readonly ownerId: string; readonly requiresMfa: boolean };

export type RoleSummary = {
  readonly id: string;
  readonly position: number;
  readonly permissions: bigint;
  readonly managed: boolean;
};

export type ChannelOverwrite = {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: bigint;
  readonly deny: bigint;
};

export type ChannelSummary = {
  readonly id: string;
  readonly type: number;
  readonly guildId: string | null;
  readonly overwrites: readonly ChannelOverwrite[];
};

export type UserProfile = { readonly username: string; readonly avatar: string | null };

export type ChannelMessage = {
  readonly id: string;
  readonly authorId: string;
  readonly marker: string | null;
};

export type DiscordMessagePayload = {
  readonly content?: string;
  readonly embeds?: readonly unknown[];
  readonly components?: readonly unknown[];
  readonly flags?: number;
};

function pathId(value: string): string {
  if (!id(value)) throw new Error('Invalid Discord ID');
  return encodeURIComponent(value);
}

function headerNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function milliseconds(seconds: number | null): number | null {
  if (seconds === null) return null;
  const result = Math.ceil(seconds * 1000);
  return Number.isFinite(result) ? result : null;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function restFailure(response: Response, mutation: boolean): Promise<RestFailure> {
  if (response.status >= 300 && response.status < 400)
    return mutation ? { kind: 'rejected', status: response.status } : { kind: 'unavailable' };
  if (response.status >= 500) return { kind: mutation ? 'uncertain' : 'unavailable' };
  if (response.status === 401 || response.status === 403)
    return { kind: 'forbidden', status: response.status };
  if (response.status === 404) {
    const body = await json(response);
    const code =
      record(body) && typeof body['code'] === 'number' && Number.isSafeInteger(body['code'])
        ? body['code']
        : null;
    return { kind: 'not_found', code };
  }
  if (response.status === 429) {
    const body = await json(response);
    const retry =
      record(body) &&
      typeof body['retry_after'] === 'number' &&
      Number.isFinite(body['retry_after']) &&
      body['retry_after'] >= 0
        ? milliseconds(body['retry_after'])
        : null;
    const headerRetry = milliseconds(headerNumber(response.headers.get('Retry-After')));
    const isJson = body !== undefined;
    const scope = !isJson
      ? 'edge'
      : response.headers.get('X-RateLimit-Global') === 'true' ||
          (record(body) && body['global'] === true)
        ? 'global'
        : response.headers.get('X-RateLimit-Scope') === 'shared'
          ? 'shared'
          : 'route';
    return {
      kind: 'rate_limited',
      retryAfterMs: Math.max(1000, retry ?? headerRetry ?? 60_000),
      scope,
    };
  }
  return { kind: 'rejected', status: response.status };
}

// one attempt per call, scheduling and retries belong to the coordinator
async function botRequest<T>(
  context: RestContext,
  path: string,
  method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
  decode: (value: unknown) => T | null,
  body?: string,
  auditReason?: string,
  noContent?: { readonly value: T },
): Promise<RestOutcome<T>> {
  const mutation = method !== 'GET';
  try {
    const headers = new Headers({
      Authorization: `Bot ${context.botToken}`,
      'User-Agent': USER_AGENT,
    });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (auditReason !== undefined) headers.set('X-Audit-Log-Reason', auditReason);
    const response = await fetch(`${DISCORD_API_BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(context.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (!response.ok) return await restFailure(response, mutation);
    if (noContent !== undefined) {
      if (response.status !== 200 && response.status !== 204) return { kind: 'malformed' };
      return { kind: 'ok', value: noContent.value };
    }
    const value = decode(await json(response));
    return value === null ? { kind: 'malformed' } : { kind: 'ok', value };
  } catch {
    return { kind: mutation ? 'uncertain' : 'unavailable' };
  }
}

function auditHeader(reason: string): string {
  let encoded = '';
  for (const character of reason) {
    const next = encodeURIComponent(character);
    if (encoded.length + next.length > 512) break;
    encoded += next;
  }
  return encoded;
}

export function getGuildMember(
  context: RestContext,
  guildId: string,
  userId: string,
): Promise<RestOutcome<MemberSnapshot>> {
  return botRequest(
    context,
    `/guilds/${pathId(guildId)}/members/${pathId(userId)}`,
    'GET',
    decodeMember,
  );
}

export function changeMemberRole(
  context: RestContext,
  method: 'PUT' | 'DELETE',
  options: { guildId: string; userId: string; roleId: string; auditReason: string },
): Promise<RestOutcome<null>> {
  return botRequest(
    context,
    `/guilds/${pathId(options.guildId)}/members/${pathId(options.userId)}/roles/${pathId(options.roleId)}`,
    method,
    () => null,
    undefined,
    auditHeader(options.auditReason),
    { value: null },
  );
}

export function getGuild(
  context: RestContext,
  guildId: string,
): Promise<RestOutcome<GuildSummary>> {
  return botRequest(context, `/guilds/${pathId(guildId)}`, 'GET', (value) =>
    record(value) && id(value['owner_id'])
      ? { ownerId: value['owner_id'], requiresMfa: value['mfa_level'] === 1 }
      : null,
  );
}

function decodeRoles(value: unknown): readonly RoleSummary[] | null {
  if (!Array.isArray(value)) return null;
  const roles: RoleSummary[] = [];
  for (const entry of value) {
    if (
      !record(entry) ||
      !id(entry['id']) ||
      typeof entry['position'] !== 'number' ||
      !Number.isSafeInteger(entry['position']) ||
      entry['position'] < 0 ||
      typeof entry['managed'] !== 'boolean'
    )
      return null;
    const permissions = bits(entry['permissions']);
    if (permissions === null) return null;
    roles.push({
      id: entry['id'],
      position: entry['position'],
      permissions,
      managed: entry['managed'],
    });
  }
  return roles;
}

export function getGuildRoles(
  context: RestContext,
  guildId: string,
): Promise<RestOutcome<readonly RoleSummary[]>> {
  return botRequest(context, `/guilds/${pathId(guildId)}/roles`, 'GET', decodeRoles);
}

function decodeChannel(value: unknown): ChannelSummary | null {
  if (
    !record(value) ||
    !id(value['id']) ||
    typeof value['type'] !== 'number' ||
    !Number.isSafeInteger(value['type']) ||
    value['type'] < 0
  )
    return null;
  const guildId = optionalId(value, 'guild_id');
  if (guildId === false) return null;
  const overwrites: ChannelOverwrite[] = [];
  if ('permission_overwrites' in value) {
    const entries = value['permission_overwrites'];
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      if (!record(entry) || !id(entry['id']) || (entry['type'] !== 0 && entry['type'] !== 1))
        return null;
      const allow = bits(entry['allow']);
      const deny = bits(entry['deny']);
      if (allow === null || deny === null) return null;
      overwrites.push({ id: entry['id'], type: entry['type'], allow, deny });
    }
  }
  return { id: value['id'], type: value['type'], guildId, overwrites };
}

export function getChannel(
  context: RestContext,
  channelId: string,
): Promise<RestOutcome<ChannelSummary>> {
  return botRequest(context, `/channels/${pathId(channelId)}`, 'GET', decodeChannel);
}

export function getCurrentUserId(context: RestContext): Promise<RestOutcome<string>> {
  return botRequest(context, '/users/@me', 'GET', (value) =>
    record(value) && id(value['id']) ? value['id'] : null,
  );
}

// avatar hash ends up in a cdn url
function decodeUser(value: unknown): UserProfile | null {
  if (!record(value)) return null;
  const username = value['username'];
  const avatar = value['avatar'] ?? null;
  if (typeof username !== 'string' || username.length < 1 || username.length > 32) return null;
  if (avatar !== null && (typeof avatar !== 'string' || !/^(a_)?[0-9a-f]{32}$/.test(avatar)))
    return null;
  return { username, avatar };
}

export function getUser(context: RestContext, userId: string): Promise<RestOutcome<UserProfile>> {
  return botRequest(context, `/users/${pathId(userId)}`, 'GET', decodeUser);
}

function messageBody(payload: DiscordMessagePayload): Record<string, unknown> {
  // copy only the owned payload fields, even if the caller supplied extra runtime properties
  return {
    ...(payload.content === undefined ? {} : { content: payload.content }),
    ...(payload.embeds === undefined ? {} : { embeds: payload.embeds }),
    ...(payload.components === undefined ? {} : { components: payload.components }),
    ...(payload.flags === undefined ? {} : { flags: payload.flags }),
    allowed_mentions: { parse: [] },
  };
}

export function createMessage(
  context: RestContext,
  options: { channelId: string; nonce?: string; payload: DiscordMessagePayload },
): Promise<RestOutcome<{ readonly messageId: string }>> {
  if (options.nonce !== undefined && options.nonce.length > 25)
    throw new Error('Discord nonce exceeds 25 characters');
  const body = messageBody(options.payload);
  if (options.nonce !== undefined) {
    body['nonce'] = options.nonce;
    body['enforce_nonce'] = true;
  }
  return botRequest(
    context,
    `/channels/${pathId(options.channelId)}/messages`,
    'POST',
    (value) => (record(value) && id(value['id']) ? { messageId: value['id'] } : null),
    JSON.stringify(body),
  );
}

export function editMessage(
  context: RestContext,
  options: { channelId: string; messageId: string; payload: DiscordMessagePayload },
): Promise<RestOutcome<null>> {
  return botRequest(
    context,
    `/channels/${pathId(options.channelId)}/messages/${pathId(options.messageId)}`,
    'PATCH',
    () => null,
    JSON.stringify(messageBody(options.payload)),
    undefined,
    { value: null },
  );
}

function decodeMessages(value: unknown): readonly ChannelMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: ChannelMessage[] = [];
  for (const entry of value) {
    if (
      !record(entry) ||
      !id(entry['id']) ||
      !record(entry['author']) ||
      !id(entry['author']['id'])
    )
      return null;
    let marker: string | null = null;
    if ('embeds' in entry) {
      if (!Array.isArray(entry['embeds'])) return null;
      for (const embed of entry['embeds']) {
        if (!record(embed)) return null;
      }
      const first: unknown = entry['embeds'][0];
      if (record(first) && 'footer' in first) {
        const footer = first['footer'];
        if (!record(footer) || typeof footer['text'] !== 'string') return null;
        marker = footer['text'];
      }
    }
    messages.push({ id: entry['id'], authorId: entry['author']['id'], marker });
  }
  return messages;
}

export function listChannelMessages(
  context: RestContext,
  options: { channelId: string; after: string; limit: number },
): Promise<RestOutcome<readonly ChannelMessage[]>> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    throw new Error('Invalid Discord message limit');
  // after=0 starts at the oldest message of the channel
  const after = options.after === '0' ? '0' : pathId(options.after);
  return botRequest(
    context,
    `/channels/${pathId(options.channelId)}/messages?after=${after}&limit=${options.limit}`,
    'GET',
    decodeMessages,
  );
}

export function deleteMessage(
  context: RestContext,
  options: { channelId: string; messageId: string },
): Promise<RestOutcome<null>> {
  return botRequest(
    context,
    `/channels/${pathId(options.channelId)}/messages/${pathId(options.messageId)}`,
    'DELETE',
    () => null,
    undefined,
    undefined,
    { value: null },
  );
}

export async function editOriginalInteractionResponse(options: {
  applicationId: string;
  interactionToken: string;
  payload: DiscordMessagePayload;
}): Promise<'ok' | 'failed'> {
  try {
    const response = await fetch(
      `${DISCORD_API_BASE}/webhooks/${pathId(options.applicationId)}/${encodeURIComponent(options.interactionToken)}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify(messageBody(options.payload)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: 'manual',
      },
    );
    return response.status === 200 || response.status === 204 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
