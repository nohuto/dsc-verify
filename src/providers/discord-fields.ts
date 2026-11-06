const MAX_ID = (1n << 64n) - 1n;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function id(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_ID;
}

export function bits(value: unknown): bigint | null {
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

export function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
