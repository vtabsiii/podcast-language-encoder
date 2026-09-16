import type { NextRequest } from 'next/server';
import { API_BASE } from '@/lib/api';
import { ORG_COOKIE, SESSION_COOKIE } from '@/lib/session';

/**
 * Same-origin proxy: `/api/<path>` → `${API_BASE_URL}/api/<path>`. Adds the bearer token from
 * the httpOnly session cookie so the browser never holds it. Streams SSE bodies through.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FORWARD_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'idempotency-key',
  'last-event-id',
  'x-request-id',
  'if-none-match',
];
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'etag',
  'location',
  'cache-control',
];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(`${API_BASE}/api/${path.map(encodeURIComponent).join('/')}`);
  url.search = req.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) headers.set('authorization', `Bearer ${token}`);
  const org = req.cookies.get(ORG_COOKIE)?.value;
  if (org) headers.set('x-organization-id', org);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal: req.signal,
    });
  } catch (e) {
    return Response.json(
      {
        code: 'UPSTREAM_UNAVAILABLE',
        message: `API unreachable: ${e instanceof Error ? e.message : 'unknown error'}`,
        correlationId: req.headers.get('x-request-id') ?? 'n/a',
        retryable: true,
        fieldErrors: [],
      },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
  if (isStream) {
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
    out.set('connection', 'keep-alive');
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
