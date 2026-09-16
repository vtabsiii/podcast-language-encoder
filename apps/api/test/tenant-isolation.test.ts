import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
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
let a: Session;
let b: Session;
let viewer: Session;
let ids: {
  projectId: string;
  uploadId: string;
  jobId: string;
  targetId: string;
  segmentId: string;
  issueId: string;
  deliverableId: string;
};

beforeAll(async () => {
  t = await startTestApp();
  a = await login(t.app, 'owner-a@example.com', 'Org A');
  b = await login(t.app, 'owner-b@example.com', 'Org B');
  // A viewer in org A (created by dev-login in a fresh org would be owner; so create a fresh org and downgrade)
  viewer = await login(t.app, 'viewer-a@example.com', 'Org A viewers', 'viewer');

  const created = await t.app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: a.headers,
    payload: { title: 'A private episode' },
  });
  const projectId = created.json().project.id as string;
  const up = await uploadSource(t.app, a, projectId, 'a.wav', makeWav(1));
  const w = new SimulatedWorker(t.app, 'test-worker-token');
  await w.drain();
  const job = await t.app.inject({
    method: 'POST',
    url: '/api/v1/localization-jobs',
    headers: { ...a.headers, 'idempotency-key': randomUUID() },
    payload: { projectId, targets: [{ locale: 'es-MX' }], acceptBetaTerms: true },
  });
  const jobId = job.json().job.id as string;
  const targetId = job.json().targets[0].id as string;
  await w.drain();
  const review = await t.app.inject({
    method: 'GET',
    url: `/api/v1/target-jobs/${targetId}/review`,
    headers: a.headers,
  });
  const seg = review.json().segments.find((x: { issues: unknown[] }) => x.issues.length > 0);
  const segmentId = seg.segment.id as string;
  const issueId = seg.issues[0].id as string;
  await t.app.inject({
    method: 'POST',
    url: `/api/v1/target-jobs/${targetId}/issues/${issueId}/resolve`,
    headers: a.headers,
    payload: { resolution: 'accepted' },
  });
  await t.app.inject({
    method: 'POST',
    url: `/api/v1/target-jobs/${targetId}/approve`,
    headers: a.headers,
    payload: { segmentIds: [] },
  });
  await w.drain();
  const del = await t.app.inject({
    method: 'GET',
    url: `/api/v1/target-jobs/${targetId}/deliverables`,
    headers: a.headers,
  });
  const deliverableId = del.json().deliverables[0].id as string;
  ids = { projectId, uploadId: up.uploadId, jobId, targetId, segmentId, issueId, deliverableId };
});
afterAll(async () => stopTestApp(t));

describe("tenant isolation (NFR-002): every route returns 404 for another organization's ids", () => {
  const routes = () => [
    { method: 'GET', url: `/api/v1/projects/${ids.projectId}` },
    {
      method: 'POST',
      url: `/api/v1/projects/${ids.projectId}/confirm-locale`,
      payload: { sourceLocale: 'en-US' },
    },
    { method: 'GET', url: `/api/v1/projects/${ids.projectId}/segments` },
    {
      method: 'POST',
      url: `/api/v1/projects/${ids.projectId}/estimate`,
      payload: { targets: [{ locale: 'es-MX' }] },
    },
    { method: 'GET', url: `/api/v1/projects/${ids.projectId}/jobs` },
    {
      method: 'POST',
      url: '/api/v1/uploads',
      payload: {
        projectId: ids.projectId,
        fileName: 'x.wav',
        contentType: 'audio/wav',
        byteSize: 10,
      },
    },
    { method: 'GET', url: `/api/v1/uploads/${ids.uploadId}` },
    { method: 'POST', url: `/api/v1/uploads/${ids.uploadId}/parts`, payload: { partNumbers: [1] } },
    {
      method: 'POST',
      url: `/api/v1/uploads/${ids.uploadId}/complete`,
      payload: { parts: [{ partNumber: 1, etag: 'x' }] },
    },
    { method: 'POST', url: `/api/v1/uploads/${ids.uploadId}/abort` },
    {
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { 'idempotency-key': randomUUID() },
      payload: { projectId: ids.projectId, targets: [{ locale: 'es-MX' }], acceptBetaTerms: true },
    },
    { method: 'GET', url: `/api/v1/localization-jobs/${ids.jobId}` },
    { method: 'POST', url: `/api/v1/localization-jobs/${ids.jobId}/cancel` },
    { method: 'GET', url: `/api/v1/target-jobs/${ids.targetId}` },
    { method: 'POST', url: `/api/v1/target-jobs/${ids.targetId}/retry` },
    { method: 'GET', url: `/api/v1/target-jobs/${ids.targetId}/review` },
    {
      method: 'POST',
      url: `/api/v1/target-jobs/${ids.targetId}/segments/${ids.segmentId}/regenerate`,
      payload: { stage: 'translation' },
    },
    {
      method: 'PUT',
      url: `/api/v1/target-jobs/${ids.targetId}/segments/${ids.segmentId}/translation`,
      payload: { adaptedText: 'x' },
    },
    {
      method: 'POST',
      url: `/api/v1/target-jobs/${ids.targetId}/issues/${ids.issueId}/resolve`,
      payload: { resolution: 'accepted' },
    },
    {
      method: 'POST',
      url: `/api/v1/target-jobs/${ids.targetId}/approve`,
      payload: { segmentIds: [] },
    },
    { method: 'GET', url: `/api/v1/target-jobs/${ids.targetId}/comments` },
    {
      method: 'POST',
      url: `/api/v1/target-jobs/${ids.targetId}/comments`,
      payload: { body: 'hi' },
    },
    { method: 'GET', url: `/api/v1/target-jobs/${ids.targetId}/deliverables` },
    { method: 'GET', url: `/api/v1/target-jobs/${ids.targetId}/deliverables/manifest` },
    {
      method: 'GET',
      url: `/api/v1/target-jobs/${ids.targetId}/deliverables/${ids.deliverableId}/download`,
    },
  ];

  test('org B cannot read, list, or mutate any object of org A', async () => {
    for (const r of routes()) {
      const res = await t.app.inject({
        method: r.method as 'GET',
        url: r.url,
        headers: { ...b.headers, ...(r as { headers?: Record<string, string> }).headers },
        ...(r.payload ? { payload: r.payload } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(res.json().code, `${r.method} ${r.url}`).toBe('NOT_FOUND');
    }
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: b.headers });
    expect(list.json().projects).toEqual([]);
  });

  test('org A still sees its own objects (the 404s above are not a broken route)', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${ids.projectId}`,
      headers: a.headers,
    });
    expect(res.statusCode).toBe(200);
  });

  test('unauthenticated requests are 401; wrong permission is 403', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(anon.statusCode).toBe(401);
    const v = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: viewer.headers,
      payload: { title: 'nope' },
    });
    expect(v.statusCode).toBe(403);
    const forged = await t.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${a.token.slice(0, -2)}xx` },
    });
    expect(forged.statusCode).toBe(401);
  });

  test('X-Organization-Id cannot select an organization the user is not a member of', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { ...a.headers, 'x-organization-id': b.organizationId },
    });
    expect(res.statusCode).toBe(403);
  });

  test('internal worker routes require the worker token', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/internal/v1/tasks/claim',
      payload: { workerId: 'x' },
    });
    expect(res.statusCode).toBe(401);
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/internal/v1/tasks/claim',
      headers: { 'x-worker-token': 'nope' },
      payload: { workerId: 'x' },
    });
    expect(wrong.statusCode).toBe(401);
  });
});

describe('row-level security', () => {
  test('the app role cannot see or write across organizations even with raw SQL', async () => {
    const seen = await t.db.withTenant(
      { organizationId: b.organizationId, userId: b.userId },
      async (tx) => (await tx.query('SELECT id FROM projects')).rows,
    );
    expect(seen).toEqual([]);
    const own = await t.db.withTenant(
      { organizationId: a.organizationId, userId: a.userId },
      async (tx) => (await tx.query('SELECT id FROM projects')).rows,
    );
    expect(own).toHaveLength(1);
    await expect(
      t.db.withTenant({ organizationId: b.organizationId, userId: b.userId }, (tx) =>
        tx.query(
          `INSERT INTO projects (id, organization_id, title, owner_user_id) VALUES (gen_random_uuid(), $1, 'smuggled', $2)`,
          [a.organizationId, b.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const none = await t.db.withSystem(
      async (tx) => (await tx.query('SELECT id FROM projects')).rows,
    );
    expect(none).toEqual([]);
  });

  test('audit events are append-only for the app role', async () => {
    await expect(
      t.db.withTenant({ organizationId: a.organizationId, userId: a.userId }, (tx) =>
        tx.query('DELETE FROM audit_events'),
      ),
    ).rejects.toThrow(/permission denied/);
    const count = await t.db.withTenant(
      { organizationId: a.organizationId, userId: a.userId },
      async (tx) => Number((await tx.query('SELECT count(*) AS n FROM audit_events')).rows[0].n),
    );
    expect(count).toBeGreaterThan(5);
  });
});
