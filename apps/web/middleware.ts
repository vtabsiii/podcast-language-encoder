import { NextResponse, type NextRequest } from 'next/server';

import { CURRENT_PATH_HEADER } from '@/lib/auth-urls';

const SESSION_COOKIE = 'pc_session';

/**
 * Unauthenticated page requests go to /login (local mode) or through /auth/refresh first
 * (Cognito mode, which renews silently when a refresh token exists and otherwise lands on
 * /login). API proxy, static assets, /login, /logout and /auth/* are exempt.
 */
export function middleware(req: NextRequest) {
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (req.cookies.get(SESSION_COOKIE)?.value) {
    const headers = new Headers(req.headers);
    headers.set(CURRENT_PATH_HEADER, next);
    return NextResponse.next({ request: { headers } });
  }
  const target = req.nextUrl.clone();
  target.search = '';
  if (process.env.AUTH_MODE === 'cognito') {
    target.pathname = '/auth/refresh';
    target.searchParams.set('next', next);
  } else {
    target.pathname = '/login';
    if (next !== '/') target.searchParams.set('next', next);
  }
  return NextResponse.redirect(target);
}

export const config = {
  matcher: [
    '/((?!login|logout|auth/|api/|_next/|favicon\\.ico|robots\\.txt|.*\\.(?:png|svg|ico|css|js|map)$).*)',
  ],
};
