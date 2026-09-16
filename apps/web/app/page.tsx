import type { Metadata } from 'next';
import Link from 'next/link';
import type { ProjectListResponse } from '@polycast/contracts';
import { Button, ProgressBar, Table } from '@polycast/ui';
import { apiGet } from '@/lib/api';
import { redirectIfUnauthenticated } from '@/lib/auth-redirect';
import { describeError } from '@/lib/errors';
import { formatCents, formatDateTime } from '@/lib/format';
import { LocaleChip } from '@/components/locale-chip';
import { ProjectStateBadge } from '@/components/state-badge';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  let data: ProjectListResponse | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<ProjectListResponse>('/api/v1/projects');
  } catch (e) {
    await redirectIfUnauthenticated(e);
    error = describeError(e);
  }
  const budget = data?.budget;
  const burn =
    budget?.enabled && budget.monthlyBudgetCents
      ? Math.min(1, budget.reservedCents / budget.monthlyBudgetCents)
      : 0;

  return (
    <section aria-labelledby="projects-heading">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 id="projects-heading">Projects</h1>
        <Link href="/projects/new">
          <Button type="button" tabIndex={-1}>
            New localization
          </Button>
        </Link>
      </div>

      {error && (
        <div className="card" role="alert">
          <strong>Could not load projects.</strong>
          <p className="muted">{error}</p>
          <p className="muted">Start the API (`pnpm --filter @polycast/api dev`) and reload.</p>
        </div>
      )}

      {budget && (
        <section className="card" aria-labelledby="budget-heading">
          <h2 id="budget-heading">Budget</h2>
          {budget.enabled ? (
            <>
              <dl className="stat-list">
                <dt>Monthly budget</dt>
                <dd>{formatCents(budget.monthlyBudgetCents)}</dd>
                <dt>Reserved by jobs</dt>
                <dd>{formatCents(budget.reservedCents)}</dd>
              </dl>
              <ProgressBar value={burn} label="Budget reserved this month" />
            </>
          ) : (
            <p className="muted">Budgets are not enabled for this organization.</p>
          )}
        </section>
      )}

      {data && data.projects.length === 0 && (
        <div className="card">
          <h2>No localizations yet</h2>
          <p className="muted">
            Upload an episode, confirm speakers and transcript, pick target languages, and get back
            localized audio or video with captions and a quality report.
          </p>
          <p className="muted">
            Supported sources: MP4, MOV, WebM video; WAV, FLAC, MP3, M4A audio. Audio-only sources
            skip lip sync.
          </p>
          <Link href="/projects/new">Start a new localization</Link>
        </div>
      )}

      {data && data.projects.length > 0 && (
        <div className="card">
          <Table caption="Projects in this organization" hideCaption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">State</th>
                <th scope="col">Targets</th>
                <th scope="col">Needs review</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => (
                <tr key={p.id}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    <Link href={`/projects/${p.id}`}>{p.title}</Link>
                    {p.asset && <div className="muted small">{p.asset.fileName}</div>}
                  </th>
                  <td>
                    <ProjectStateBadge state={p.state} />
                  </td>
                  <td>
                    {p.targets.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="chips">
                        {p.targets.map((t) => (
                          <LocaleChip key={t.targetJobId} target={t} />
                        ))}
                      </div>
                    )}
                  </td>
                  <td>{p.needsReviewCount > 0 ? <strong>{p.needsReviewCount}</strong> : '0'}</td>
                  <td>
                    <time dateTime={p.createdAt}>{formatDateTime(p.createdAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  );
}
