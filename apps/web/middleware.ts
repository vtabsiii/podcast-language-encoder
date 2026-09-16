import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'pc_session';

/** Unauthenticated page requests go to /login. API proxy, static assets and /login are exempt. */
export function middleware(req: NextRequest) {
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const login = req.nextUrl.clone();
  login.pathname = '/login';
  login.search = '';
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (next !== '/') login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    '/((?!login|logout|api/|_next/|favicon\\.ico|robots\\.txt|.*\\.(?:png|svg|ico|css|js|map)$).*)',
  ],
};
