export type AppConfig = {
  readonly origin: string;
  readonly hostname: string;
  readonly applicationId: string;
  readonly publicKeyHex: string;
  readonly guildId: string;
  readonly memberRoleId: string;
  readonly verificationChannelId: string;
  readonly logChannelId: string;
  readonly staffRoleIds: readonly string[];
  readonly punitiveRoleIds: readonly string[];
  readonly legacyRoleId: string | null;
  readonly supportUrl: string;
  readonly sourceUrl: string;
  readonly turnstileSiteKey: string;
  readonly release: string;
  readonly discordBotToken: string;
  readonly discordClientSecret: string;
  readonly turnstileSecretKey: string;
  readonly capabilitySigningKey: string;
};

type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly invalid: readonly string[] };

const SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/;
const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;
const SIGNING_KEY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const RELEASE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PLACEHOLDER_PATTERN = /REPLACE_WITH|example\.(com|org|net|test)|^0+$/i;
// published cloudflare dummy sitekeys and secrets start with 1x, 2x, 3x
const TURNSTILE_TEST_KEY_PATTERN = /^[123]x0000000000000000/;

function readString(raw: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = raw[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readIdList(raw: Readonly<Record<string, unknown>>, name: string): string[] | null {
  const value = raw[name];
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') return null;
  const ids = value.split(',').map((id) => id.trim());
  return ids.every((id) => SNOWFLAKE_PATTERN.test(id)) ? ids : null;
}

function parseOrigin(value: string): URL | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  const isLocalHttp = url.protocol === 'http:' && url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !isLocalHttp) return null;
  return url.origin === value ? url : null;
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === 'https:';
}

export function readConfig(raw: Readonly<Record<string, unknown>>): ConfigResult {
  const invalid: string[] = [];

  const required = (name: string, isValid: (value: string) => boolean = () => true): string => {
    const value = readString(raw, name);
    if (value === null || !isValid(value)) {
      invalid.push(name);
      return '';
    }
    return value;
  };
  const snowflake = (name: string): string =>
    required(name, (value) => SNOWFLAKE_PATTERN.test(value));
  const idList = (name: string): string[] => {
    const ids = readIdList(raw, name);
    if (ids === null) invalid.push(name);
    return ids ?? [];
  };

  const environment = readString(raw, 'ENVIRONMENT');
  if (environment !== 'development' && environment !== 'staging' && environment !== 'production') {
    invalid.push('ENVIRONMENT');
  }

  const origin = required('APP_ORIGIN', (value) => parseOrigin(value) !== null);
  const legacyRoleId = readString(raw, 'LEGACY_UNVERIFIED_ROLE_ID');
  if (legacyRoleId !== null && !SNOWFLAKE_PATTERN.test(legacyRoleId)) {
    invalid.push('LEGACY_UNVERIFIED_ROLE_ID');
  }

  const config: AppConfig = {
    origin,
    hostname: origin === '' ? '' : new URL(origin).hostname,
    applicationId: snowflake('DISCORD_APPLICATION_ID'),
    publicKeyHex: required('DISCORD_PUBLIC_KEY', (value) => PUBLIC_KEY_PATTERN.test(value)),
    guildId: snowflake('DISCORD_GUILD_ID'),
    memberRoleId: snowflake('DISCORD_MEMBER_ROLE_ID'),
    verificationChannelId: snowflake('DISCORD_VERIFICATION_CHANNEL_ID'),
    logChannelId: snowflake('DISCORD_LOG_CHANNEL_ID'),
    staffRoleIds: idList('DISCORD_STAFF_ROLE_IDS'),
    punitiveRoleIds: idList('DISCORD_PUNITIVE_ROLE_IDS'),
    legacyRoleId,
    supportUrl: required('SUPPORT_URL', isHttpsUrl),
    sourceUrl: required('SOURCE_URL', isHttpsUrl),
    turnstileSiteKey: required('TURNSTILE_SITE_KEY'),
    release: required('RELEASE', (value) => RELEASE_PATTERN.test(value)),
    discordBotToken: required('DISCORD_BOT_TOKEN'),
    discordClientSecret: required('DISCORD_CLIENT_SECRET'),
    turnstileSecretKey: required('TURNSTILE_SECRET_KEY'),
    capabilitySigningKey: required('CAPABILITY_SIGNING_KEY', (value) =>
      SIGNING_KEY_PATTERN.test(value),
    ),
  };

  if (config.staffRoleIds.includes(config.memberRoleId)) invalid.push('DISCORD_STAFF_ROLE_IDS');
  if (config.punitiveRoleIds.includes(config.memberRoleId)) {
    invalid.push('DISCORD_PUNITIVE_ROLE_IDS');
  }
  if (legacyRoleId === config.memberRoleId || config.punitiveRoleIds.includes(legacyRoleId ?? '')) {
    invalid.push('LEGACY_UNVERIFIED_ROLE_ID');
  }
  if (config.verificationChannelId === config.logChannelId) {
    invalid.push('DISCORD_LOG_CHANNEL_ID');
  }

  if (environment !== 'development') invalid.push(...findDeployedConfigFaults(config));

  return invalid.length > 0 ? { ok: false, invalid: [...new Set(invalid)] } : { ok: true, config };
}

function findDeployedConfigFaults(config: AppConfig): string[] {
  const faults: string[] = [];
  if (!config.origin.startsWith('https://')) faults.push('APP_ORIGIN');

  const publicSettings: readonly (readonly [string, string])[] = [
    ['APP_ORIGIN', config.origin],
    ['DISCORD_PUBLIC_KEY', config.publicKeyHex],
    ['SUPPORT_URL', config.supportUrl],
    ['SOURCE_URL', config.sourceUrl],
    ['TURNSTILE_SITE_KEY', config.turnstileSiteKey],
    ['DISCORD_BOT_TOKEN', config.discordBotToken],
    ['DISCORD_CLIENT_SECRET', config.discordClientSecret],
    ['TURNSTILE_SECRET_KEY', config.turnstileSecretKey],
  ];
  for (const [name, value] of publicSettings) {
    if (PLACEHOLDER_PATTERN.test(value)) faults.push(name);
  }

  if (TURNSTILE_TEST_KEY_PATTERN.test(config.turnstileSiteKey)) faults.push('TURNSTILE_SITE_KEY');
  if (TURNSTILE_TEST_KEY_PATTERN.test(config.turnstileSecretKey)) {
    faults.push('TURNSTILE_SECRET_KEY');
  }
  if (config.release === 'local' || config.release === 'test') faults.push('RELEASE');
  return faults;
}
