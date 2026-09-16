import { randomBytes } from 'node:crypto';

/**
 * UUID v7 (RFC 9562): 48-bit Unix ms timestamp, then random bits. Sortable by creation
 * time, which keeps B-tree inserts sequential and makes ids safe to expose in URLs
 * (they leak creation time, not tenant or count). Node 22 has no built-in v7 yet.
 */
export function uuidv7(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError('timestamp must be a non-negative integer below 2^48');
  }
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUID_RE.test(value);
}

/** Extract the embedded Unix-ms timestamp. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuidv7(id)) throw new RangeError('not a UUID v7');
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
