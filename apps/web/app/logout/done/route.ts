import { cookies } from 'next/headers';
import { clearAuthCookies, redirectTo } from '@/lib/auth-session';

export const dynamic = 'force-dynamic';

/** Return trip from the Cognito hosted-UI /logout: cookies are already gone, land on /login. */
export async function GET() {
  const jar = await cookies();
  clearAuthCookies(jar);
  return redirectTo('/login');
}
