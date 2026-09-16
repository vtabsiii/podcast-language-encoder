import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ORG_COOKIE, SESSION_COOKIE, WHO_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Clears the session cookies and returns to /login. */
export async function GET(req: NextRequest) {
  const jar = await cookies();
  for (const name of [SESSION_COOKIE, ORG_COOKIE, WHO_COOKIE]) jar.delete(name);
  return NextResponse.redirect(new URL('/login', req.nextUrl.origin));
}
