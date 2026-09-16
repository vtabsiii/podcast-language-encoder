/**
 * Only same-origin, path-absolute redirect targets are honoured after sign-in. Anything else
 * (absolute URLs, protocol-relative `//host`, backslash tricks, control characters) falls back.
 */
export function safeNext(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback;
  }
  return raw;
}
