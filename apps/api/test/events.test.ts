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
let s: Session;
let base: string;

beforeAll(async () => {
  t = await startTestApp();
  s = await login(t.app, 'sse@example.com', 'SSE Org');
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => stopTestApp(t));

async function readEvents(
  url: string,
  headers: Record<string, string>,
  until: (events: { name: string; data: unknown }[]) => boolean,
  timeoutMs = 10_000,
) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { name: string; id?: string; data: unknown }[] = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now()),
      ),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.startsWith(':')) continue;
      const name = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const id = /^id: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      events.push({ name, ...(id ? { id } : {}), data: data ? JSON.parse(data) : null });
    }
    if (until(events)) break;
  }
  ctrl.abort();
  return events;
}

describe('SSE (FR-052)', () => {
  test('streams ready then stage events for the project, within 2 s of the transition', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: s.headers,
      payload: { title: 'Live' },
    });
    const projectId = created.json().project.id as string;
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: s.headers,
      payload: { title: 'Other' },
    });
    const otherId = other.json().project.id as string;

    const streaming = readEvents(`${base}/api/v1/events?projectId=${projectId}`, s.headers, (ev) =>
      ev.some((e) => e.name === 'analysis.completed'),
    );
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await uploadSource(t.app, s, otherId, 'o.wav', makeWav(1)); // events for another project must not leak in
    await uploadSource(t.app, s, projectId, 'l.wav', makeWav(1));
    await new SimulatedWorker(t.app, 'test-worker-token').drain();
    const events = await streaming;
    expect(Date.now() - started).toBeLessThan(2000 + 1500);
    expect(events[0]?.name).toBe('ready');
    const names = events.map((e) => e.name);
    expect(names).toContain('upload.completed');
    expect(names).toContain('asset.validated');
    expect(names).toContain('analysis.completed');
    for (const e of events.slice(1))
      expect((e.data as { payload: { projectId: string } }).payload.projectId).toBe(projectId);
  });

  test('Last-Event-ID replays missed events; other organizations see nothing', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: s.headers,
      payload: { title: 'Replay' },
    });
    const projectId = created.json().project.id as string;
    const first = await readEvents(
      `${base}/api/v1/events?projectId=${projectId}`,
      s.headers,
      (ev) => ev.length >= 1,
      1000,
    );
    expect(first[0]?.name).toBe('ready');
    await uploadSource(t.app, s, projectId, 'r.wav', makeWav(1));
    const w = new SimulatedWorker(t.app, 'test-worker-token');
    await w.drain();
    const job = await t.app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': randomUUID() },
      payload: { projectId, targets: [{ locale: 'de-DE' }], acceptBetaTerms: true },
    });
    expect(job.statusCode).toBe(201);
    // Replay everything after the very first event id of this org (a UUID v7 well in the past).
    const replayed = await readEvents(
      `${base}/api/v1/events?projectId=${projectId}`,
      { ...s.headers, 'last-event-id': '00000000-0000-7000-8000-000000000000' },
      (ev) => ev.some((e) => e.name === 'job.created'),
      3000,
    );
    expect(replayed.map((e) => e.name)).toContain('analysis.completed');
    expect(replayed.map((e) => e.name)).toContain('job.created');

    const other = await login(t.app, 'someone-else@example.com', 'Elsewhere');
    const theirs = await readEvents(
      `${base}/api/v1/events`,
      { ...other.headers, 'last-event-id': '00000000-0000-7000-8000-000000000000' },
      (ev) => ev.length >= 2,
      1500,
    );
    expect(theirs.map((e) => e.name)).toEqual(['ready']);
  });
});
