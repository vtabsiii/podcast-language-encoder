import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ProjectDetailResponse } from '@polycast/contracts';
import type { JobListResponse } from '@/lib/contract-types';
import { apiGet } from '@/lib/api';
import { redirectIfUnauthenticated } from '@/lib/auth-redirect';
import { ApiError, describeError } from '@/lib/errors';
import { ProcessingView } from './processing-view';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Processing' };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let detail: ProjectDetailResponse;
  let jobs: JobListResponse = { jobs: [] };
  try {
    detail = await apiGet<ProjectDetailResponse>(`/api/v1/projects/${id}`);
    jobs = await apiGet<JobListResponse>(`/api/v1/projects/${id}/jobs`).catch(() => ({ jobs: [] }));
  } catch (e) {
    await redirectIfUnauthenticated(e);
    if (e instanceof ApiError && e.status === 404) notFound();
    return (
      <section aria-labelledby="project-error-heading">
        <h1 id="project-error-heading">Project</h1>
        <div className="card" role="alert">
          <strong>Could not load the project.</strong>
          <p className="muted">{describeError(e)}</p>
        </div>
      </section>
    );
  }
  return <ProcessingView initialDetail={detail} initialJobs={jobs} />;
}
