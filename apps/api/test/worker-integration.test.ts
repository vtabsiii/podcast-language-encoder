import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ReviewResponse } from '@polycast/contracts';
import {
  login,
  makeWav,
  startTestApp,
  stopTestApp,
  uploadSource,
  type Session,
  type TestApp,
} from './helpers.js';

/**
 * Runs the real Python media worker (services/media-worker) against a listening API and walks
 * the whole M1 slice: upload → validate → analyse → job → stages → review → regenerate → approve →
 * package. Requires the worker venv (CI installs it); skipped locally when it is absent.
 */
const workerDir = resolve(import.meta.dirname, '../../../services/media-worker');
const python = process.env['WORKER_PYTHON'] ?? resolve(workerDir, '.venv/bin/python');
const available = existsSync(python);

let t: TestApp;
let s: Session;
let base: string;

async function runWorkerOnce(): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(
      python,
      ['-m', 'polycast_worker', '--api-url', base, '--once', '--worker-id', 'it-worker'],
      {
        cwd: workerDir,
        env: {
          ...process.env,
          WORKER_TOKEN: 'test-worker-token',
          STORAGE_DRIVER: 'local',
          LOCAL_STORAGE_DIR: t.config.LOCAL_STORAGE_DIR,
          POLYCAST_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let err = '';
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`worker exited ${code}: ${err.slice(-2000)}`)),
    );
  });
}

describe.skipIf(!available)(
  'media worker integration (real Python worker, ffmpeg optional)',
  () => {
    beforeAll(async () => {
      t = await startTestApp();
      s = await login(t.app, 'it@example.com', 'Integration Org');
      base = await t.app.listen({ port: 0, host: '127.0.0.1' });
    });
    afterAll(async () => stopTestApp(t));

    test('the full slice reaches COMPLETE with real deliverables and checksums', async () => {
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: s.headers,
        payload: { title: 'Real worker' },
      });
      const projectId = created.json().project.id as string;
      await uploadSource(t.app, s, projectId, 'episode.wav', makeWav(12));
      await runWorkerOnce();

      const detail = await t.app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}`,
        headers: s.headers,
      });
      expect(detail.json().asset.status).toBe('READY_TO_CONFIGURE');
      expect(detail.json().analysis.detectedLocale).toBe('en-US');
      expect(detail.json().analysis.segmentCount).toBeGreaterThan(1);
      expect(detail.json().asset.metadata.durationUs).toBe(12_000_000);

      const job = await t.app.inject({
        method: 'POST',
        url: '/api/v1/localization-jobs',
        headers: { ...s.headers, 'idempotency-key': randomUUID() },
        payload: { projectId, targets: [{ locale: 'es-MX' }], acceptBetaTerms: true },
      });
      expect(job.statusCode).toBe(201);
      const targetId = job.json().targets[0].id as string;
      await runWorkerOnce();

      let review = (
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/target-jobs/${targetId}/review`,
          headers: s.headers,
        })
      ).json() as ReviewResponse;
      expect(review.target.state).toBe('NEEDS_REVIEW');
      expect(review.openIssues).toBe(1);
      const flagged = review.segments.find((x) => x.issues.some((i) => i.resolution === 'open'))!;
      expect(flagged.translation?.adaptedText.startsWith('[es-MX]')).toBe(true);
      expect(review.speakers.length).toBe(2);

      const regen = await t.app.inject({
        method: 'POST',
        url: `/api/v1/target-jobs/${targetId}/segments/${flagged.segment.id}/regenerate`,
        headers: s.headers,
        payload: { stage: 'translation', hint: 'shorter' },
      });
      expect(regen.statusCode).toBe(200);
      await runWorkerOnce();
      review = (
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/target-jobs/${targetId}/review`,
          headers: s.headers,
        })
      ).json() as ReviewResponse;
      expect(review.openIssues).toBe(0);
      const again = review.segments.find((x) => x.segment.id === flagged.segment.id)!;
      expect(again.translation?.generation).toBe(2);
      expect(again.translation?.adaptedText.startsWith('[es-MX v2]')).toBe(true);

      const approve = await t.app.inject({
        method: 'POST',
        url: `/api/v1/target-jobs/${targetId}/approve`,
        headers: s.headers,
        payload: { segmentIds: [] },
      });
      expect(approve.statusCode).toBe(200);
      await runWorkerOnce();

      const target = await t.app.inject({
        method: 'GET',
        url: `/api/v1/target-jobs/${targetId}`,
        headers: s.headers,
      });
      expect(target.json().target.state).toBe('COMPLETE');
      const del = (
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/target-jobs/${targetId}/deliverables`,
          headers: s.headers,
        })
      ).json() as {
        deliverables: {
          id: string;
          kind: string;
          fileName: string;
          sha256: string;
          byteSize: number;
        }[];
      };
      expect(del.deliverables.map((d) => d.kind).sort()).toEqual([
        'captions-srt',
        'captions-vtt',
        'checksums',
        'media',
        'provenance-manifest',
        'qc-report',
        'transcript-json',
      ]);

      // Download every file through the signed link and verify the checksum list matches the bytes.
      const { createHash } = await import('node:crypto');
      const files = new Map<string, string>();
      for (const d of del.deliverables) {
        const link = (
          await t.app.inject({
            method: 'GET',
            url: `/api/v1/target-jobs/${targetId}/deliverables/${d.id}/download`,
            headers: s.headers,
          })
        ).json() as { url: string };
        const u = new URL(link.url);
        const res = await t.app.inject({ method: 'GET', url: u.pathname + u.search });
        expect(res.statusCode, d.fileName).toBe(200);
        const body = res.rawPayload;
        expect(body.length, d.fileName).toBe(d.byteSize);
        expect(createHash('sha256').update(body).digest('hex'), d.fileName).toBe(d.sha256);
        files.set(d.fileName, body.toString('utf8'));
      }
      const checksums = files.get('checksums.sha256')!;
      for (const line of checksums.trim().split('\n')) {
        const [hash, name] = line.split(/\s+\*?/);
        const d = del.deliverables.find((x) => x.fileName === name);
        expect(d, `checksum entry ${name}`).toBeDefined();
        expect(d!.sha256).toBe(hash);
      }
      const manifest = JSON.parse(files.get('provenance.json')!) as {
        mock: boolean;
        disclosure: string;
        targetLocale: string;
      };
      expect(manifest.mock).toBe(true);
      expect(manifest.targetLocale).toBe('es-MX');
      expect(files.get('captions.es-MX.srt')).toContain('-->');
    });
  },
);
