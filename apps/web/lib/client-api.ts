'use client';

import { errorFromResponse } from './errors';

export interface ClientApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Browser-side API call through the same-origin proxy (`/api/v1/...` → route handler → API).
 * The bearer token lives in an httpOnly cookie, so the browser never sees it.
 */
export async function api<T>(path: string, init: ClientApiInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ?? null,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
