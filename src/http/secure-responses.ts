import type { ErrorResponse } from '../../shared/browser-contract';

function securityHeaders(headers: Readonly<Record<string, string>>): Headers {
  const result = new Headers(headers);
  result.set('Cache-Control', 'no-store');
  result.set('Referrer-Policy', 'no-referrer');
  result.set('X-Content-Type-Options', 'nosniff');
  result.set('X-Frame-Options', 'DENY');
  result.set(
    'Content-Security-Policy',
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  return result;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const responseHeaders = securityHeaders(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function errorResponse(
  status: number,
  body: ErrorResponse,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return jsonResponse(body, status, headers);
}

function hasForbiddenRedirectCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '\\' || code <= 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export function redirectResponse(location: string): Response {
  if (
    !location.startsWith('/') ||
    location.startsWith('//') ||
    hasForbiddenRedirectCharacters(location)
  ) {
    throw new Error('Invalid redirect path.');
  }
  const headers = securityHeaders({});
  headers.set('Location', location);
  return new Response(null, { status: 303, headers });
}

export function externalRedirectResponse(url: string): Response {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    !url.startsWith('https://') ||
    hasForbiddenRedirectCharacters(url)
  ) {
    throw new Error('Invalid external redirect URL.');
  }
  const headers = securityHeaders({});
  headers.set('Location', parsed.href);
  return new Response(null, { status: 302, headers });
}

export function notFoundResponse(): Response {
  return errorResponse(404, { code: 'not_found', message: 'Not found.' });
}

export function methodNotAllowedResponse(allowed: readonly string[]): Response {
  return errorResponse(
    405,
    { code: 'invalid_request', message: 'Method not allowed.' },
    { Allow: allowed.join(', ') },
  );
}
