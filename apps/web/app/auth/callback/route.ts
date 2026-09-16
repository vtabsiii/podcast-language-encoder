import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { authMode, cognitoConfig } from '@/lib/auth-config';
import {
  AUTH_PATH,
  OAUTH_COOKIE,
  clearSessionCookies,
  establishSession,
  readPendingAuth,
  redirectTo,
} from '@/lib/auth-session';
import { loginUrl, organizationUrl, type LoginErrorCode } from '@/lib/auth-urls';
import { exchangeCode, redirectUri } from '@/lib/cognito';
import { ORG_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sameState(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Cognito returns here with `?code=&state=`. The state must match the in-flight cookie; the
 * code is exchanged (with the PKCE verifier) for tokens, the ID token becomes `pc_session`,
 * the refresh token `pc_refresh`, and `/me` fills in the organization cookies. Codes and
 * tokens are never logged; failures surface as short codes on /login.
 */
export async function GET(req: NextRequest) {
  if (authMode() !== 'cognito') return redirectTo(loginUrl('/'));
  const config = cognitoConfig();
  const jar = await cookies();

  const pending = readPendingAuth(jar);
  jar.delete({ name: OAUTH_COOKIE, path: AUTH_PATH });
  const next = pending?.next ?? '/';
  const fail = (code: LoginErrorCode) => {
    clearSessionCookies(jar);
    return redirectTo(loginUrl(next, code));
  };

  const params = req.nextUrl.searchParams;
  const state = params.get('state');
  if (!pending || !state || !sameState(state, pending.state)) return fail('state');
  const code = params.get('code');
  if (!code || params.get('error')) return fail('denied');

  let tokens;
  try {
    tokens = await exchangeCode(config, {
      code,
      codeVerifier: pending.verifier,
      redirectUri: redirectUri(config, req.nextUrl.origin),
    });
  } catch {
    return fail('exchange');
  }

  let outcome: 'ok' | 'no-organization';
  try {
    outcome = await establishSession(jar, {
      idToken: tokens.id_token,
      expiresInSeconds: tokens.expires_in,
      refreshToken: tokens.refresh_token,
      preferredOrganizationId: jar.get(ORG_COOKIE)?.value ?? null,
    });
  } catch {
    return fail('profile');
  }

  return redirectTo(outcome === 'no-organization' ? organizationUrl(next) : next);
}
