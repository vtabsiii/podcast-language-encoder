import type { FastifyServerOptions } from 'fastify';

/**
 * Structured logging with redaction (A-17, NFR-010). Anything under these keys is removed
 * before a line is written, wherever it appears in the object graph. The list is exported so
 * the redaction test can assert against it.
 */
export const FORBIDDEN_LOG_KEYS = [
  'transcript',
  'text',
  'adaptedText',
  'literalText',
  'words',
  'hint',
  'mediaUrl',
  'signedUrl',
  'url',
  'embedding',
  'faceEmbedding',
  'voiceEmbedding',
  'authorization',
  'x-worker-token',
  'cookie',
  'accessToken',
  'token',
  'secret',
  'password',
  'signature',
] as const;

const forbidden = new Set<string>(FORBIDDEN_LOG_KEYS.map((k) => k.toLowerCase()));

/** Forbidden keys plus anything that names a URL/URI: signed links must never be logged. */
export function isForbiddenKey(key: string): boolean {
  const k = key.toLowerCase();
  return forbidden.has(k) || /ur[il]$/.test(k);
}

/**
 * Deep-clone `value` dropping every forbidden key. Only plain objects and arrays are walked;
 * class instances (sockets, requests, streams) are reduced to their constructor name so a
 * getter can never throw inside the logger. Cycles are cut.
 */
export function scrub<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack } as unknown as T;
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}]` as unknown as T;
  if (seen.has(value as object)) return '[circular]' as unknown as T;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => scrub(v, seen)) as unknown as T;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    return `[${(value as { constructor?: { name?: string } }).constructor?.name ?? 'object'}]` as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(k)) continue;
    out[k] = scrub(v, seen);
  }
  return out as T;
}

interface ReqLike {
  method?: string;
  url?: string;
  id?: string;
}
interface ResLike {
  statusCode?: number;
}

export const serializeReq = (req: ReqLike) => ({
  method: req.method ?? '',
  path: (req.url ?? '').split('?')[0] ?? '',
  id: req.id ?? '',
});
export const serializeRes = (res: ResLike) => ({ statusCode: res.statusCode ?? 0 });

export function loggerOptions(level = 'info'): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-worker-token"]'],
      remove: true,
    },
    formatters: {
      // Runs before serializers: reduce req/res to their safe shape first, then scrub the rest.
      log: (obj) => {
        const { req, res, ...rest } = obj as { req?: ReqLike; res?: ResLike } & Record<
          string,
          unknown
        >;
        return {
          ...(req ? { req: serializeReq(req) } : {}),
          ...(res ? { res: serializeRes(res) } : {}),
          ...scrub(rest),
        };
      },
    },
    serializers: {
      req: (req: ReqLike) => serializeReq(req),
      res: (res: ResLike) => serializeRes(res),
    },
  };
}
