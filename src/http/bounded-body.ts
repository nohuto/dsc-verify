export const MAX_DISCORD_BODY_BYTES = 64 * 1024;

export const MAX_BROWSER_BODY_BYTES = 8 * 1024;

export type BodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_large' | 'unreadable' };

export type JsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export async function readBoundedBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const length = request.headers.get('Content-Length')?.trim();
  if (length !== undefined && !/[^0-9]/.test(length) && Number(length) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }
  if (request.body === null) return { ok: true, bytes: new Uint8Array() };
  try {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'unreadable' };
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export function parseJson(bytes: Uint8Array): JsonResult {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}
