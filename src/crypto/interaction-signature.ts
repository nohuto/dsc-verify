import { parseSeconds } from './canonical-encoding';

type SignatureRejection = 'malformed' | 'stale' | 'invalid';

type SignatureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureRejection };

function decodeHex(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyInteractionSignature(options: {
  publicKeyHex: string;
  signatureHex: string | null;
  timestamp: string | null;
  body: Uint8Array;
  nowMs: number;
}): Promise<SignatureResult> {
  const { publicKeyHex, signatureHex, timestamp, body, nowMs } = options;
  if (
    signatureHex === null ||
    signatureHex.length !== 128 ||
    /[^0-9a-f]/.test(signatureHex) ||
    publicKeyHex.length !== 64 ||
    /[^0-9a-f]/.test(publicKeyHex) ||
    timestamp === null ||
    !Number.isFinite(nowMs)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const timestampSeconds = parseSeconds(timestamp);
  if (timestampSeconds === null) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowMs - timestampSeconds * 1000) > 300_000) {
    return { ok: false, reason: 'stale' };
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      decodeHex(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const timestampBytes = new TextEncoder().encode(timestamp);
    const signedBytes = new Uint8Array(timestampBytes.length + body.length);
    signedBytes.set(timestampBytes);
    signedBytes.set(body, timestampBytes.length);
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      decodeHex(signatureHex),
      signedBytes,
    );
    return valid ? { ok: true } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
