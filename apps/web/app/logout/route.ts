import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { authMode, cognitoConfig } from '@/lib/auth-config';
import { clearAuthCookies, redirectTo } from '@/lib/auth-session';
import { hostedLogoutUrl, logoutUri } from '@/lib/cognito';

export const dynamic = 'force-dynamic';

/**
 * Clears every session cookie and returns to /login. Under Cognito it also ends the hosted-UI
 * session: the browser goes to the pool's /logout, which sends it back to /logout/done (a
 * registered sign-out URL; Cognito matches those exactly, so no query string is involved).
 */
export async function GET(req: NextRequest) {
  const jar = await cookies();
  clearAuthCookies(jar);
  if (authMode() === 'cognito') {
    try {
      const config = cognitoConfig();
      return redirectTo(
        hostedLogoutUrl(config, { logoutUri: logoutUri(config, req.nextUrl.origin) }),
        302,
      );
    } catch {
      // Misconfigured pool: the local cookies are gone, which is the part that matters here.
    }
  }
  return redirectTo('/login');
}
