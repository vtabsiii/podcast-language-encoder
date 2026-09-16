import Link from 'next/link';
import type { MeResponse } from '@polycast/contracts';
import { Button } from '@polycast/ui';
import { organizationUrl, startUrl, type LoginErrorCode } from '@/lib/auth-urls';
import { OrganizationSwitcher } from './organization-switcher';

const ERROR_COPY: Record<LoginErrorCode, string> = {
  state: 'That sign-in attempt expired or did not start here. Please sign in again.',
  denied: 'Sign-in was cancelled or refused by the identity provider.',
  exchange: 'The identity provider did not accept the sign-in. Please try again.',
  profile: 'Signed in, but your profile could not be loaded. Please try again.',
  session: 'Your session has expired. Please sign in again.',
};

function copyFor(code: string | undefined): string | null {
  if (!code) return null;
  // Own-property check: the code comes from the URL, so `constructor` etc. must not resolve.
  return Object.hasOwn(ERROR_COPY, code)
    ? ERROR_COPY[code as LoginErrorCode]
    : 'Sign-in failed. Please try again.';
}

export interface CognitoLoginProps {
  /** Current identity when the session cookie still works, else null. */
  me: MeResponse | null;
  next: string;
  error?: string | undefined;
}

/**
 * Hosted-UI sign-in. With a live session this doubles as the organization switcher the topbar
 * links to, so the same page works in both auth modes.
 */
export function CognitoLogin({ me, next, error }: CognitoLoginProps) {
  const message = copyFor(error);
  const start = startUrl(next);
  return (
    <section aria-labelledby="login-heading" style={{ maxWidth: 520 }}>
      <h1 id="login-heading">Sign in</h1>
      {message && (
        <div id="login-error" role="alert" className="alert">
          {message}
        </div>
      )}
      {me ? (
        <>
          <p className="muted">
            Signed in as {me.user.displayName} ({me.user.email}).
          </p>
          <OrganizationSwitcher
            memberships={me.memberships}
            current={me.organization.id}
            next={next}
          />
          <p className="small">
            <Link href={organizationUrl(next)}>Create a new organization</Link>
            {' · '}
            {/* Plain anchor: this is a route handler that starts an external redirect. */}
            <a href={start}>Sign in with a different account</a>
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            Sign in with your organization&apos;s identity provider. You will be sent to the sign-in
            page and brought back here.
          </p>
          <div className="card">
            <div className="actions">
              <a href={start}>
                <Button type="button" tabIndex={-1}>
                  Sign in
                </Button>
              </a>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
