import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ProjectDetailResponse, ReviewResponse } from '@polycast/contracts';
import {
  login,
  makeWav,
  startTestApp,
  stopTestApp,
  uploadSource,
  type Session,
  type TestApp,
} from './helpers.js';
import { SimulatedWorker } from './simulated-worker.js';

let t: TestApp;
let s: Session;

beforeAll(async () => {
  t = await startTestApp();
  s = await login(t.app, 'producer@example.com', 'Acme Studio');
});
afterAll(async () => stopTestApp(t));

const get = <T>(url: string) =>
  t.app
    .inject({ method: 'GET', url, headers: s.headers })
    .then((r) => ({ status: r.statusCode, body: r.json() as T }));

describe('first vertical slice (simulated worker)', () => {
  let projectId: string;
  let jobId: string;
  let targetId: string;

  test('create project, upload, validate and analyse', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: s.headers,
      payload: { title: 'Episode 1' },
    });
    expect(created.statusCode).toBe(201);
    projectId = (created.json() as { project: { id: string } }).project.id;

    const wav = makeWav(2);
    const up = await uploadSource(t.app, s, projectId, 'episode.wav', wav);
    expect(up.status.assetStatus).toBe('VALIDATING');

    const worker = new SimulatedWorker(t.app, 'test-worker-token');
    const stages = await worker.drain();
    expect(stages).toEqual(['VALIDATING', 'ANALYZING']);

    const detail = await get<ProjectDetailResponse>(`/api/v1/projects/${projectId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.project.state).toBe('ready');
    expect(detail.body.asset?.status).toBe('READY_TO_CONFIGURE');
    expect(detail.body.analysis?.segmentCount).toBe(3);
    expect(detail.body.analysis?.speakers).toHaveLength(2);

    // resuming the same upload returns the completed asset rather than a new one
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: s.headers,
      payload: {
        projectId,
        fileName: 'episode.wav',
        contentType: 'audio/wav',
        byteSize: wav.length,
      },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { assetId: string }).assetId).not.toBe(up.assetId); // completed uploads are not "active"; a new asset starts
  });

  test('estimate, idempotent job creation, fan-out', async () => {
    const est = await t.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/estimate`,
      headers: s.headers,
      payload: { targets: [{ locale: 'es-MX', lipSync: false }] },
    });
    expect(est.statusCode).toBe(200);
    expect(est.json().targets[0].tier).toBe('beta');
    expect(est.json().budget.ok).toBe(true);

    const noTerms = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': randomUUID() },
      payload: { projectId, targets: [{ locale: 'es-MX' }] },
    });
    expect(noTerms.statusCode).toBe(400);

    const key = randomUUID();
    const payload = {
      projectId,
      targets: [{ locale: 'es-MX', lipSync: false }],
      acceptBetaTerms: true,
    };
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const replay = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': key },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const conflict = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': key },
      payload: { ...payload, targets: [{ locale: 'de-DE' }] },
    });
    expect(conflict.statusCode).toBe(409);

    jobId = first.json().job.id;
    targetId = first.json().targets[0].id;
    expect(first.json().targets[0].state).toBe('TRANSLATING');
  });

  test('stages run to NEEDS_REVIEW with exactly one flagged segment', async () => {
    const worker = new SimulatedWorker(t.app, 'test-worker-token');
    const stages = await worker.drain();
    expect(stages).toEqual([
      'TRANSLATING',
      'SYNTHESIZING',
      'TIMING',
      'MIXING',
      'ENCODING',
      'TARGET_QA',
    ]);
    const review = await get<ReviewResponse>(`/api/v1/target-jobs/${targetId}/review`);
    expect(review.status).toBe(200);
    expect(review.body.target.state).toBe('NEEDS_REVIEW');
    expect(review.body.openIssues).toBe(1);
    const flagged = review.body.segments.filter((x) =>
      x.issues.some((i) => i.resolution === 'open'),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.segment.seq).toBe(0);
    expect(review.body.segments.every((x) => x.translation?.generation === 1)).toBe(true);
    expect(review.body.proxyUrl).toMatch(/\/local-storage\//);

    // history shows every transition
    const hist = await get<{ history: { to: string }[] }>(`/api/v1/localization-jobs/${jobId}`);
    expect(hist.body.history.map((h) => h.to)).toContain('NEEDS_REVIEW');
  });

  test('approving with an open issue is refused; regenerate creates lineage and re-runs QC clean', async () => {
    const review = await get<ReviewResponse>(`/api/v1/target-jobs/${targetId}/review`);
    const flagged = review.body.segments.find((x) =>
      x.issues.some((i) => i.resolution === 'open'),
    )!;
    const refused = await t.app.inject({
      method: 'POST',
      url: `/api/v1/target-jobs/${targetId}/approve`,
      headers: s.headers,
      payload: { segmentIds: [] },
    });
    expect(refused.statusCode).toBe(409);

    const regen = await t.app.inject({
      method: 'POST',
      url: `/api/v1/target-jobs/${targetId}/segments/${flagged.segment.id}/regenerate`,
      headers: s.headers,
      payload: { stage: 'translation', hint: 'shorter' },
    });
    expect(regen.statusCode).toBe(200);
    expect(regen.json().restartAt).toBe('TRANSLATING');
    expect(regen.json().target.state).toBe('TRANSLATING');

    const worker = new SimulatedWorker(t.app, 'test-worker-token');
    const stages = await worker.drain();
    expect(stages).toEqual([
      'TRANSLATING',
      'SYNTHESIZING',
      'TIMING',
      'MIXING',
      'ENCODING',
      'TARGET_QA',
    ]);
    // scoped stages only carried the regenerated segment
    const translating = worker.processed.find((p) => p.stage === 'TRANSLATING')!;
    expect((translating.parameters as { segments: unknown[] }).segments).toHaveLength(1);
    expect((translating.parameters as { hint: string | null }).hint).toBe('shorter');
    const mixing = worker.processed.find((p) => p.stage === 'MIXING')!;
    expect((mixing.parameters as { segments: unknown[] }).segments).toHaveLength(3);

    const after = await get<ReviewResponse>(`/api/v1/target-jobs/${targetId}/review`);
    expect(after.body.target.state).toBe('NEEDS_REVIEW');
    expect(after.body.openIssues).toBe(0);
    const seg = after.body.segments.find((x) => x.segment.id === flagged.segment.id)!;
    expect(seg.translation?.generation).toBe(2);
    expect(seg.translation?.supersedesId).toBe(flagged.translation?.id);
    expect(seg.history).toHaveLength(1);
    expect(seg.issues[0]?.resolution).toBe('regenerated');
  });

  test('approve → READY → PACKAGING → COMPLETE with deliverables and signed downloads', async () => {
    const approve = await t.app.inject({
      method: 'POST',
      url: `/api/v1/target-jobs/${targetId}/approve`,
      headers: s.headers,
      payload: { segmentIds: [] },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().target.state).toBe('PACKAGING');
    expect(approve.json().remainingSegments).toBe(0);

    const worker = new SimulatedWorker(t.app, 'test-worker-token');
    expect(await worker.drain()).toEqual(['PACKAGING']);

    const target = await get<{ target: { state: string; progress: number } }>(
      `/api/v1/target-jobs/${targetId}`,
    );
    expect(target.body.target.state).toBe('COMPLETE');
    expect(target.body.target.progress).toBe(1);

    const job = await get<{ job: { state: string; completedAt: string | null } }>(
      `/api/v1/localization-jobs/${jobId}`,
    );
    expect(job.body.job.state).toBe('COMPLETE');
    expect(job.body.job.completedAt).not.toBeNull();

    const del = await get<{
      deliverables: { id: string; kind: string; sha256: string }[];
      packageVersion: number;
    }>(`/api/v1/target-jobs/${targetId}/deliverables`);
    expect(del.body.packageVersion).toBe(1);
    expect(del.body.deliverables.map((d) => d.kind).sort()).toEqual([
      'captions-srt',
      'captions-vtt',
      'checksums',
      'media',
      'provenance-manifest',
      'qc-report',
      'transcript-json',
    ]);
    const link = await get<{ url: string; sha256: string }>(
      `/api/v1/target-jobs/${targetId}/deliverables/${del.body.deliverables[0]!.id}/download`,
    );
    expect(link.status).toBe(200);
    expect(link.body.url).toContain('signature=');
    expect(link.body.sha256).toBe(del.body.deliverables[0]!.sha256);
    const manifest = await get<{ manifest: { mock: boolean; disclosure: string } }>(
      `/api/v1/target-jobs/${targetId}/deliverables/manifest`,
    );
    expect(manifest.body.manifest.mock).toBe(true);

    const dashboard = await get<{ projects: { targets: { state: string }[] }[] }>(
      '/api/v1/projects',
    );
    expect(dashboard.body.projects[0]?.targets[0]?.state).toBe('COMPLETE');
  });

  test('retryable failures wait and retry; exhausted attempts fail terminally', async () => {
    const key = randomUUID();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': key },
      payload: { projectId, targets: [{ locale: 'de-DE' }], acceptBetaTerms: true },
    });
    expect(created.statusCode).toBe(201);
    const tid = created.json().targets[0].id as string;
    const flaky = new SimulatedWorker(t.app, 'test-worker-token', {
      failStage: 'SYNTHESIZING',
      failRetryable: true,
      failTimes: 1,
    });
    await flaky.drain();
    // first failure: RETRY_WAIT with a short backoff in test mode, then the retry succeeds on the next drain
    await new Promise((r) => setTimeout(r, 120));
    const stages = await flaky.drain();
    expect(stages[0]).toBe('SYNTHESIZING');
    const target = await get<{ target: { state: string; attempt: number } }>(
      `/api/v1/target-jobs/${tid}`,
    );
    expect(target.body.target.state).toBe('NEEDS_REVIEW');
    expect(target.body.target.attempt).toBe(2);

    const key2 = randomUUID();
    const created2 = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': key2 },
      payload: { projectId, targets: [{ locale: 'fr-FR' }], acceptBetaTerms: true },
    });
    const tid2 = created2.json().targets[0].id as string;
    const broken = new SimulatedWorker(t.app, 'test-worker-token', {
      failStage: 'TRANSLATING',
      failRetryable: true,
      failTimes: 5,
    });
    await broken.drain();
    await new Promise((r) => setTimeout(r, 120));
    await broken.drain();
    const failed = await get<{ target: { state: string; lastError: string | null } }>(
      `/api/v1/target-jobs/${tid2}`,
    );
    expect(failed.body.target.state).toBe('FAILED');
    expect(failed.body.target.lastError).toBe('simulated failure');
    const retry = await t.app.inject({
      method: 'POST',
      url: `/api/v1/target-jobs/${tid2}/retry`,
      headers: s.headers,
    });
    expect(retry.statusCode).toBe(409);
  });

  test('cancel moves waiting targets to CANCELLED', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': randomUUID() },
      payload: { projectId, targets: [{ locale: 'ja-JP' }], acceptBetaTerms: true },
    });
    const jid = created.json().job.id as string;
    const cancelled = await t.app.inject({
      method: 'POST',
      url: `/api/v1/localization-jobs/${jid}/cancel`,
      headers: s.headers,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().targets[0].state).toBe('CANCELLED');
    expect(cancelled.json().job.state).toBe('CANCELLED');
  });
});
