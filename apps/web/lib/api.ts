import 'server-only';
import { cookies } from 'next/headers';
import { ORG_COOKIE, SESSION_COOKIE } from './session';
import { errorFromResponse } from './errors';

/** Base URL of the control-plane API. Read server-side only; never shipped to the browser. */
export const API_BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

export interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip the session cookie (e.g. the dev-login call itself). */
  anonymous?: boolean;
}

/** Server-component / server-action fetch that attaches the session cookie as a bearer token. */
export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (!init.anonymous) {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) headers.set('authorization', `Bearer ${token}`);
    const org = jar.get(ORG_COOKIE)?.value;
    if (org) headers.set('x-organization-id', org);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}
