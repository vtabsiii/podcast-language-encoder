import 'server-only';
import { headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { authMode } from './auth-config';
import { CURRENT_PATH_HEADER, loginUrl, refreshUrl } from './auth-urls';
import { ApiError } from './errors';
import { safeNext } from './safe-next';

/**
 * First line of a server component's `catch` around an API call. Lets Next's own control-flow
 * errors through, and when the API rejected the session token (401) sends the browser to a
 * fresh sign-in: through /auth/refresh under Cognito (silent renewal, with its own loop guard),
 * straight to /login locally. The current path comes from the middleware and is sanitised.
 */
export async function redirectIfUnauthenticated(e: unknown): Promise<void> {
  unstable_rethrow(e);
  if (!(e instanceof ApiError) || e.status !== 401) return;
  const current = safeNext((await headers()).get(CURRENT_PATH_HEADER));
  redirect(authMode() === 'cognito' ? refreshUrl(current, 'unauthorized') : loginUrl(current));
}
