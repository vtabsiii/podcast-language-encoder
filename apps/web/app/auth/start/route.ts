import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { authMode, cognitoConfig } from '@/lib/auth-config';
import { redirectTo, setPendingAuth } from '@/lib/auth-session';
import { loginUrl } from '@/lib/auth-urls';
import { authorizeUrl, redirectUri } from '@/lib/cognito';
import { codeChallenge, generateCodeVerifier, generateState } from '@/lib/pkce';
import { safeNext } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Begins the Cognito hosted-UI sign-in: mints a PKCE verifier and CSRF state, parks them (with
 * the sanitised `next` path) in a 10-minute cookie scoped to /auth, and sends the browser to
 * /oauth2/authorize. Nothing is logged: the verifier and state are secrets for this request.
 */
export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  if (authMode() !== 'cognito') return redirectTo(loginUrl(next));
  const config = cognitoConfig();

  const verifier = generateCodeVerifier();
  const state = generateState();
  const jar = await cookies();
  setPendingAuth(jar, { verifier, state, next });

  return redirectTo(
    authorizeUrl(config, {
      state,
      codeChallenge: codeChallenge(verifier),
      redirectUri: redirectUri(config, req.nextUrl.origin),
    }),
    302,
  );
}
