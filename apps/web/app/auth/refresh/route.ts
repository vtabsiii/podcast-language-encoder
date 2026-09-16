import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { authMode, cognitoConfig } from '@/lib/auth-config';
import {
  REFRESH_COOKIE,
  REFRESHED_COOKIE,
  clearAuthCookies,
  clearSessionCookies,
  establishSession,
  markRefreshed,
  redirectTo,
} from '@/lib/auth-session';
import { loginUrl, organizationUrl } from '@/lib/auth-urls';
import { refreshTokens } from '@/lib/cognito';
import { ORG_COOKIE } from '@/lib/session';
import { safeNext } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Silent renewal. With a `pc_refresh` cookie, trades it for a fresh ID token and returns to
 * `next`; without one, or when Cognito refuses, falls back to /login. `?reason=unauthorized`
 * marks a redirect caused by the API rejecting a token that was present: if that happens within
 * a minute of a successful refresh the token is not going to get better, so we sign out instead
 * of looping.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const next = safeNext(params.get('next'));
  const jar = await cookies();

  if (authMode() !== 'cognito') {
    clearSessionCookies(jar);
    return redirectTo(loginUrl(next));
  }

  const refreshToken = jar.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) {
    clearSessionCookies(jar);
    return redirectTo(loginUrl(next));
  }
  if (params.get('reason') === 'unauthorized' && jar.get(REFRESHED_COOKIE)) {
    clearAuthCookies(jar);
    return redirectTo(loginUrl(next, 'session'));
  }

  let tokens;
  try {
    tokens = await refreshTokens(cognitoConfig(), refreshToken);
  } catch {
    clearAuthCookies(jar);
    return redirectTo(loginUrl(next, 'session'));
  }

  let outcome: 'ok' | 'no-organization';
  try {
    outcome = await establishSession(jar, {
      idToken: tokens.id_token,
      expiresInSeconds: tokens.expires_in,
      preferredOrganizationId: jar.get(ORG_COOKIE)?.value ?? null,
    });
  } catch {
    clearSessionCookies(jar);
    return redirectTo(loginUrl(next, 'profile'));
  }
  markRefreshed(jar);
  return redirectTo(outcome === 'no-organization' ? organizationUrl(next) : next);
}
