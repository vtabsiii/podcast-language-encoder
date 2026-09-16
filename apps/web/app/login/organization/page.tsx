import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { loginUrl } from '@/lib/auth-urls';
import { safeNext } from '@/lib/safe-next';
import { getSession } from '@/lib/session';
import { OrganizationForm } from './organization-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Create organization' };

/** Shown to a signed-in principal with no organization membership yet. */
export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext = '/' } = await searchParams;
  const next = safeNext(rawNext);
  const session = await getSession();
  if (!session) redirect(loginUrl(next));

  return (
    <section aria-labelledby="organization-heading" style={{ maxWidth: 520 }}>
      <h1 id="organization-heading">Create your organization</h1>
      <p className="muted">
        You are signed in but do not belong to an organization yet. Name one to become its owner;
        budgets and members are managed later under Admin. To join an existing organization, ask its
        owner to invite you instead.
      </p>
      <OrganizationForm next={next} />
    </section>
  );
}
