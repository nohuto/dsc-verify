// read only, calls only the GET helpers and prints finding codes, never bodies

import { readConfig } from '../src/deployment-config.ts';
import {
  getChannel,
  getCurrentUserId,
  getGuild,
  getGuildMember,
  getGuildRoles,
} from '../src/providers/discord-rest.ts';
import type { ChannelSummary, RestContext, RestOutcome } from '../src/providers/discord-rest.ts';
import { evaluatePreflight, hasPreflightErrors } from '../src/coordinator/guild-preflight.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function unwrap<T>(label: string, outcome: RestOutcome<T>): T {
  if (outcome.kind === 'ok') return outcome.value;
  const status = 'status' in outcome ? ` ${outcome.status}` : '';
  return fail(`${label} failed: ${outcome.kind}${status}`);
}

async function readChannel(
  label: string,
  context: RestContext,
  channelId: string,
): Promise<ChannelSummary | null> {
  const outcome = await getChannel(context, channelId);
  // 403 = bot cant view the channel, report it as a finding instead of failing
  if (outcome.kind === 'not_found' || (outcome.kind === 'forbidden' && outcome.status === 403)) {
    console.log(`note ${label} lookup returned ${outcome.kind}`);
    return null;
  }
  return unwrap(label, outcome);
}

const result = readConfig(process.env);
if (!result.ok) fail(`invalid settings: ${result.invalid.join(', ')}`);

const { config } = result;
const context: RestContext = { botToken: config.discordBotToken };

const botUserId = unwrap('GET /users/@me', await getCurrentUserId(context));
const guild = unwrap('GET /guilds/{id}', await getGuild(context, config.guildId));
const roles = unwrap('GET /guilds/{id}/roles', await getGuildRoles(context, config.guildId));
const botMember = unwrap(
  'GET /guilds/{id}/members/{bot}',
  await getGuildMember(context, config.guildId, botUserId),
);
const verificationChannel = await readChannel(
  'verification_channel',
  context,
  config.verificationChannelId,
);
const logChannel = await readChannel('log_channel', context, config.logChannelId);

const findings = evaluatePreflight(config, {
  botUserId,
  botRoleIds: botMember.roleIds,
  guildOwnerId: guild.ownerId,
  guildRequiresMfa: guild.requiresMfa,
  roles,
  verificationChannel,
  logChannel,
});

for (const { severity, code } of findings) console.log(`${severity} ${code}`);
const errorCount = findings.filter((finding) => finding.severity === 'error').length;
console.log(`preflight: ${errorCount} error(s), ${findings.length - errorCount} warning(s)`);
process.exitCode = hasPreflightErrors(findings) ? 1 : 0;
