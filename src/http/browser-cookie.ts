export const BROWSER_COOKIE_NAME = '__Host-verify';

type CookieResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'value'; readonly value: string };

export function readCookie(request: Request, name: string): CookieResult {
  const header = request.headers.get('Cookie');
  if (header === null) return { kind: 'absent' };
  let result: CookieResult = { kind: 'absent' };
  for (const part of header.split(';')) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator) !== name) continue;
    if (result.kind === 'value') return { kind: 'duplicate' };
    result = { kind: 'value', value: cookie.slice(separator + 1) };
  }
  return result;
}

export function buildBrowserCookie(value: string, maxAgeSeconds: number): string {
  if (/[^A-Za-z0-9_.-]/.test(value)) throw new Error('Invalid browser cookie value.');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new Error('Invalid browser cookie lifetime.');
  }
  return `${BROWSER_COOKIE_NAME}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
