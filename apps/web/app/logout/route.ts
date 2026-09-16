import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { authMode, cognitoConfig } from '@/lib/auth-config';
import { clearAuthCookies, redirectTo } from '@/lib/auth-session';
import { hostedLogoutUrl, logoutUri } from '@/lib/cognito';

export const dynamic = 'force-dynamic';

/**
 * Clears every session cookie and returns to /login. Under Cognito the first visit also ends
 * the hosted-UI session: the browser goes to the pool's /logout, which sends it back here with
 * `?done=1`, and that second visit lands on /login.
 */
export async function GET(req: NextRequest) {
  const jar = await cookies();
  clearAuthCookies(jar);
  if (authMode() === 'cognito' && req.nextUrl.searchParams.get('done') !== '1') {
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
