import type { Metadata } from 'next';
import type { MeResponse } from '@polycast/contracts';
import { apiFetch } from '@/lib/api';
import { getSession } from '@/lib/session';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next = '/' } = await searchParams;
  const session = await getSession();
  let me: MeResponse | null = null;
  if (session) {
    try {
      me = await apiFetch<MeResponse>('/api/v1/me');
    } catch {
      me = null; // token expired or API down: fall through to a fresh sign-in
    }
  }
  const memberships = me?.memberships ?? [];
  const defaults = {
    email: me?.user.email ?? session?.who?.email ?? '',
    displayName: me?.user.displayName ?? session?.who?.displayName ?? '',
    organizationId: session?.organizationId ?? null,
  };

  return (
    <section aria-labelledby="login-heading" style={{ maxWidth: 520 }}>
      <h1 id="login-heading">Sign in</h1>
      <p className="muted">
        Development sign-in. Production uses the organization&apos;s identity provider; this form is
        disabled there.
      </p>
      <LoginForm memberships={memberships} defaults={defaults} next={next} />
    </section>
  );
}
