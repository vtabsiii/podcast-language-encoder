import { safeNext } from './safe-next';

/**
 * Relative URLs of the sign-in flow. Pure string helpers shared by server code and the browser
 * API client. `next` is always sanitised so only same-origin paths survive a round-trip.
 */

/** Request header set by the middleware with the page path, for the stale-session redirect. */
export const CURRENT_PATH_HEADER = 'x-pc-path';

/** Short codes carried in `/login?error=…`; the login page maps them to copy. Never free text. */
export type LoginErrorCode = 'state' | 'denied' | 'exchange' | 'profile' | 'session';

export function loginUrl(next: string, error?: LoginErrorCode): string {
  const params = new URLSearchParams();
  const target = safeNext(next);
  if (target !== '/') params.set('next', target);
  if (error) params.set('error', error);
  const qs = params.toString();
  return qs ? `/login?${qs}` : '/login';
}

export function startUrl(next: string): string {
  return `/auth/start?next=${encodeURIComponent(safeNext(next))}`;
}

export function refreshUrl(next: string, reason?: 'unauthorized'): string {
  const params = new URLSearchParams({ next: safeNext(next) });
  if (reason) params.set('reason', reason);
  return `/auth/refresh?${params.toString()}`;
}

export function organizationUrl(next: string): string {
  return `/login/organization?next=${encodeURIComponent(safeNext(next))}`;
}
