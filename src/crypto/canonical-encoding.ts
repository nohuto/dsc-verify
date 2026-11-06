export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeBase64Url(text: string): Uint8Array | null {
  if (/[^A-Za-z0-9_-]/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64Url(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

export function isCanonicalKeyEncoding(encoded: string): boolean {
  return encoded.length === 43 && decodeBase64Url(encoded)?.length === 32;
}

export function randomToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function digestToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

export function parseSeconds(text: string): number | null {
  if (text.length === 0 || text.length > 16 || /[^0-9]/.test(text)) return null;
  const seconds = Number(text);
  return Number.isSafeInteger(seconds) && String(seconds) === text ? seconds : null;
}
