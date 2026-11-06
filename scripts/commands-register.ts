// prints the payload by default, only --apply contacts discord

import { COMMANDS } from '../shared/slash-commands.ts';
import {
  DISCORD_API_BASE,
  UPSTREAM_TIMEOUT_MS,
  USER_AGENT,
} from '../src/providers/discord-rest.ts';

const SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/;
// fetch header errors quote the value, a bad token must never reach it
const BOT_TOKEN_PATTERN = /^(?!REPLACE_WITH)[A-Za-z0-9._-]{20,}$/;

function readSetting(name: string, pattern: RegExp, invalid: string[]): string {
  const value = process.env[name]?.trim() ?? '';
  if (!pattern.test(value)) invalid.push(name);
  return value;
}

async function applyCommands(): Promise<number> {
  const invalid: string[] = [];
  const applicationId = readSetting('DISCORD_APPLICATION_ID', SNOWFLAKE_PATTERN, invalid);
  const guildId = readSetting('DISCORD_GUILD_ID', SNOWFLAKE_PATTERN, invalid);
  const botToken = readSetting('DISCORD_BOT_TOKEN', BOT_TOKEN_PATTERN, invalid);
  if (invalid.length > 0) {
    console.error(`invalid settings: ${invalid.join(', ')}`);
    return 1;
  }

  try {
    const url = `${DISCORD_API_BASE}/applications/${applicationId}/guilds/${guildId}/commands`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(COMMANDS),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: 'error',
    });
    console.log(`status=${response.status} commands=${COMMANDS.length}`);
    return response.ok ? 0 : 1;
  } catch {
    console.error('request failed without a response from Discord');
    return 1;
  }
}

if (process.argv.includes('--apply')) {
  process.exitCode = await applyCommands();
} else {
  console.log(JSON.stringify(COMMANDS, null, 2));
  console.error('dry run: nothing was sent, pass --apply to register');
}
