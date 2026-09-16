import 'server-only';
import type { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { MeResponse } from '@polycast/contracts';
import { z } from 'zod';
import { apiFetch } from './api';
import { authMode } from './auth-config';
import { ApiError } from './errors';
import { ORG_COOKIE, SESSION_COOKIE, WHO_COOKIE, type Who } from './session';

/**
 * Cookie plumbing shared by the dev form, the Cognito callback/refresh routes and the
 * organization actions. Every cookie is httpOnly + sameSite=lax, `secure` in production.
 * Nothing here logs: values are tokens.
 */

export type CookieJar = Awaited<ReturnType<typeof cookies>>;

/** Cognito refresh token. Only the /auth/* routes ever need it, so it is path-scoped there. */
export const REFRESH_COOKIE = 'pc_refresh';
/** In-flight authorization request: PKCE verifier, state and the sanitised `next` path. */
export const OAUTH_COOKIE = 'pc_oauth';
/** Set for a minute after a successful refresh so a still-rejected token cannot loop. */
export const REFRESHED_COOKIE = 'pc_refreshed';
export const AUTH_PATH = '/auth';

const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_MAX_AGE_SECONDS = 10 * 60;
const REFRESHED_MAX_AGE_SECONDS = 60;

const secure = process.env.NODE_ENV === 'production';
const base = { httpOnly: true, sameSite: 'lax' as const, secure };

export function setSessionToken(jar: CookieJar, token: string, expires: Date): void {
  jar.set(SESSION_COOKIE, token, { ...base, path: '/', expires });
}

export function setRefreshToken(jar: CookieJar, token: string): void {
  jar.set(REFRESH_COOKIE, token, { ...base, path: AUTH_PATH, maxAge: REFRESH_MAX_AGE_SECONDS });
}

/** Records the organization the principal is acting in, exactly as the dev form does. */
export function setOrganization(jar: CookieJar, who: Who, expires: Date): void {
  jar.set(ORG_COOKIE, who.organizationId, { ...base, path: '/', expires });
  jar.set(WHO_COOKIE, JSON.stringify(who), { ...base, path: '/', expires });
}

export function markRefreshed(jar: CookieJar): void {
  jar.set(REFRESHED_COOKIE, '1', { ...base, path: AUTH_PATH, maxAge: REFRESHED_MAX_AGE_SECONDS });
}

export function clearSessionCookies(jar: CookieJar): void {
  for (const name of [SESSION_COOKIE, ORG_COOKIE, WHO_COOKIE]) jar.delete({ name, path: '/' });
}

/** Everything, including the refresh token and any in-flight authorization request. */
export function clearAuthCookies(jar: CookieJar): void {
  clearSessionCookies(jar);
  for (const name of [REFRESH_COOKIE, OAUTH_COOKIE, REFRESHED_COOKIE]) {
    jar.delete({ name, path: AUTH_PATH });
  }
}

const PendingAuthSchema = z.object({
  verifier: z.string().min(43).max(128),
  state: z.string().min(16),
  next: z.string(),
});
export type PendingAuth = z.infer<typeof PendingAuthSchema>;

export function setPendingAuth(jar: CookieJar, pending: PendingAuth): void {
  jar.set(OAUTH_COOKIE, JSON.stringify(pending), {
    ...base,
    path: AUTH_PATH,
    maxAge: OAUTH_MAX_AGE_SECONDS,
  });
}

export function readPendingAuth(jar: CookieJar): PendingAuth | null {
  const raw = jar.get(OAUTH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = PendingAuthSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Standard claims we read without verification, only to align cookie lifetimes and fallbacks. */
const ClaimsSchema = z.object({
  exp: z.number().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
});
export type TokenClaims = z.infer<typeof ClaimsSchema>;

export function tokenClaims(token: string): TokenClaims {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const parsed = ClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Lifetime of the organization cookies. Under Cognito they must outlive the ID token so the
 * chosen organization survives a refresh; locally they follow the dev token as before.
 */
export function organizationExpiry(token: string): Date {
  if (authMode() === 'cognito') return new Date(Date.now() + REFRESH_MAX_AGE_SECONDS * 1000);
  const exp = tokenClaims(token).exp;
  return exp ? new Date(exp * 1000) : new Date(Date.now() + 24 * 60 * 60 * 1000);
}

/** `GET /me` answers 403 FORBIDDEN "No organization membership" for a brand-new principal. */
export function isNoOrganizationError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.envelope.code === 'FORBIDDEN';
}

export function whoFromMe(me: MeResponse): Who {
  return {
    email: me.user.email,
    displayName: me.user.displayName,
    organizationId: me.organization.id,
    organizationName: me.organization.name,
    role: me.role,
  };
}

/** Resolves the principal's identity in `organizationId` (or the API's default when null). */
export async function loadWho(token: string, organizationId: string | null): Promise<Who> {
  const me = await apiFetch<MeResponse>('/api/v1/me', { token, organizationId });
  return whoFromMe(me);
}

export interface EstablishSessionInput {
  idToken: string;
  expiresInSeconds: number;
  /** Present after a code exchange; absent after a refresh (the old one stays). */
  refreshToken?: string;
  /** Organization to keep acting in, e.g. the current `pc_org`; null lets the API choose. */
  preferredOrganizationId: string | null;
}

/**
 * Stores the ID token, then resolves the organization through `/me`. Returns
 * `no-organization` when the principal has no membership yet (the caller sends them to
 * /login/organization); throws for any other API failure.
 */
export async function establishSession(
  jar: CookieJar,
  input: EstablishSessionInput,
): Promise<'ok' | 'no-organization'> {
  setSessionToken(jar, input.idToken, new Date(Date.now() + input.expiresInSeconds * 1000));
  if (input.refreshToken) setRefreshToken(jar, input.refreshToken);

  let who: Who;
  try {
    who = await loadWho(input.idToken, input.preferredOrganizationId);
  } catch (e) {
    const staleOrganization =
      input.preferredOrganizationId !== null && e instanceof ApiError && e.status === 403;
    if (!staleOrganization) {
      if (isNoOrganizationError(e)) return 'no-organization';
      throw e;
    }
    // A revoked membership in the remembered organization must not block sign-in.
    try {
      who = await loadWho(input.idToken, null);
    } catch (retry) {
      if (isNoOrganizationError(retry)) return 'no-organization';
      throw retry;
    }
  }
  setOrganization(jar, who, organizationExpiry(input.idToken));
  return 'ok';
}

/** Same-origin redirect with a relative Location so proxies never see an internal host. */
export function redirectTo(location: string, status: 302 | 303 | 307 = 303): NextResponse {
  return new NextResponse(null, { status, headers: { location } });
}
