import {
  decodeBase64Url,
  encodeBase64Url,
  isCanonicalKeyEncoding,
  parseSeconds,
  randomToken,
} from './canonical-encoding';

export type CapabilityPurpose = 'entry' | 'browser';

export type DerivedTokenPurpose = 'csrf' | 'challenge';

export type CapabilityContext = { readonly applicationId: string; readonly guildId: string };

export type IssuedCapability = {
  readonly envelope: string;
  readonly handle: string;
  readonly expirySeconds: number;
};

export type VerifiedCapability = { readonly handle: string; readonly expirySeconds: number };

export type CapabilityRejection = 'malformed' | 'expired' | 'invalid_mac';

export type CapabilityResult =
  | { readonly ok: true; readonly capability: VerifiedCapability }
  | { readonly ok: false; readonly reason: CapabilityRejection };

type MacFields = {
  readonly key: CryptoKey;
  readonly purpose: CapabilityPurpose | DerivedTokenPurpose;
  readonly context: CapabilityContext;
  readonly handle: string;
  readonly expirySeconds: number;
};

export async function importSigningKey(encoded: string): Promise<CryptoKey | null> {
  if (!isCanonicalKeyEncoding(encoded)) return null;
  const bytes = decodeBase64Url(encoded);
  if (bytes === null) return null;
  try {
    return await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
  } catch {
    return null;
  }
}

function validContext(context: CapabilityContext): boolean {
  return [context.applicationId, context.guildId].every(
    (id) => id.length > 0 && id.length <= 20 && id[0] !== '0' && !/[^0-9]/.test(id),
  );
}

function validTokenFields(
  context: CapabilityContext,
  handle: string,
  expirySeconds: number,
): boolean {
  return (
    validContext(context) &&
    isCanonicalKeyEncoding(handle) &&
    Number.isSafeInteger(expirySeconds) &&
    expirySeconds >= 0
  );
}

function macInput({ purpose, context, handle, expirySeconds }: MacFields): Uint8Array {
  // validated fields cannot contain NUL, the fixed field order binds every purpose and context
  return new TextEncoder().encode(
    [
      'dsc-verify/capability',
      'v1',
      purpose,
      context.applicationId,
      context.guildId,
      handle,
      String(expirySeconds),
    ].join('\0'),
  );
}

async function signFields(fields: MacFields): Promise<string> {
  if (!validTokenFields(fields.context, fields.handle, fields.expirySeconds)) {
    throw new Error('Invalid token fields.');
  }
  const mac = await crypto.subtle.sign('HMAC', fields.key, macInput(fields));
  return encodeBase64Url(new Uint8Array(mac));
}

async function verifyFields(fields: MacFields, encodedMac: string): Promise<boolean> {
  const mac = decodeBase64Url(encodedMac);
  if (mac === null) return false;
  try {
    return await crypto.subtle.verify('HMAC', fields.key, mac, macInput(fields));
  } catch {
    return false;
  }
}

export async function issueCapability(options: {
  key: CryptoKey;
  purpose: CapabilityPurpose;
  context: CapabilityContext;
  expirySeconds: number;
}): Promise<IssuedCapability> {
  const { expirySeconds } = options;
  const handle = randomToken();
  const mac = await signFields({ ...options, handle });
  return { envelope: `v1.${handle}.${String(expirySeconds)}.${mac}`, handle, expirySeconds };
}

export async function verifyCapability(options: {
  key: CryptoKey;
  purpose: CapabilityPurpose;
  context: CapabilityContext;
  envelope: string;
  nowMs: number;
}): Promise<CapabilityResult> {
  const { key, purpose, context, envelope, nowMs } = options;
  if (envelope.length > 128) return { ok: false, reason: 'malformed' };
  const segments = envelope.split('.');
  const [version, handle, expiry, encodedMac] = segments;
  if (
    segments.length !== 4 ||
    version !== 'v1' ||
    handle === undefined ||
    expiry === undefined ||
    encodedMac === undefined
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const expirySeconds = parseSeconds(expiry);
  if (
    expirySeconds === null ||
    !isCanonicalKeyEncoding(handle) ||
    !isCanonicalKeyEncoding(encodedMac) ||
    !validContext(context) ||
    !Number.isFinite(nowMs)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (expirySeconds * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return (await verifyFields({ key, purpose, context, handle, expirySeconds }, encodedMac))
    ? { ok: true, capability: { handle, expirySeconds } }
    : { ok: false, reason: 'invalid_mac' };
}

export function deriveToken(options: {
  key: CryptoKey;
  purpose: DerivedTokenPurpose;
  context: CapabilityContext;
  handle: string;
  expirySeconds: number;
}): Promise<string> {
  return signFields(options);
}

export async function verifyDerivedToken(options: {
  key: CryptoKey;
  purpose: DerivedTokenPurpose;
  context: CapabilityContext;
  handle: string;
  expirySeconds: number;
  token: string;
}): Promise<boolean> {
  const { context, handle, expirySeconds, token } = options;
  if (!validTokenFields(context, handle, expirySeconds) || !isCanonicalKeyEncoding(token)) {
    return false;
  }
  return verifyFields(options, token);
}
