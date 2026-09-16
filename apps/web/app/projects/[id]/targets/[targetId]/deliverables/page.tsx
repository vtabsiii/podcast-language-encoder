import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { DeliverablesResponse } from '@polycast/contracts';
import { apiGet } from '@/lib/api';
import { redirectIfUnauthenticated } from '@/lib/auth-redirect';
import { ApiError, describeError } from '@/lib/errors';
import { JobStateBadge } from '@/components/state-badge';
import { DeliverablesTable } from './deliverables-table';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Deliverables' };

export default async function DeliverablesPage({
  params,
}: {
  params: Promise<{ id: string; targetId: string }>;
}) {
  const { id, targetId } = await params;
  let data: DeliverablesResponse;
  try {
    data = await apiGet<DeliverablesResponse>(`/api/v1/target-jobs/${targetId}/deliverables`);
  } catch (e) {
    await redirectIfUnauthenticated(e);
    if (e instanceof ApiError && e.status === 404) notFound();
    return (
      <section aria-labelledby="deliverables-error-heading">
        <h1 id="deliverables-error-heading">Deliverables</h1>
        <div className="card" role="alert">
          <strong>Could not load deliverables.</strong>
          <p className="muted">{describeError(e)}</p>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby="deliverables-heading" className="stack">
      <p className="muted small">
        <Link href="/">Projects</Link> / <Link href={`/projects/${id}`}>Processing</Link> /
        Deliverables
      </p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 id="deliverables-heading" style={{ margin: 0 }}>
          Deliverables <span lang={data.target.locale}>{data.target.locale}</span>
        </h1>
        <div className="row">
          <JobStateBadge state={data.target.state} />
          <span className="muted">package version {data.packageVersion}</span>
        </div>
      </div>
      <DeliverablesTable targetId={targetId} deliverables={data.deliverables} />
    </section>
  );
}
