import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { isForbiddenKey, loggerOptions, scrub } from '../src/logging.js';
import { createDb } from '../src/db/pool.js';
import { login, makeWav, resetDatabase, testConfig, uploadSource } from './helpers.js';
import { SimulatedWorker } from './simulated-worker.js';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/pool.js';

const lines: string[] = [];
let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  const config = testConfig();
  db = createDb(config);
  await resetDatabase(db);
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const opts = loggerOptions('debug');
  app = await buildApp({ config, db, logger: false });
  // attach a child logger to the sink so request logs and explicit logs are captured
  const pino = (await import('pino')).default;
  const logger = pino({ ...opts, level: 'debug' }, sink);
  app.addHook('preHandler', async (req) => {
    logger.debug(
      { req, body: req.body, headers: req.headers, query: req.query, params: req.params },
      'request',
    );
  });
  app.addHook('onSend', async (req, reply, payload) => {
    logger.debug(
      { req, res: reply, payload: typeof payload === 'string' ? JSON.parse(payload) : payload },
      'response',
    );
    return payload;
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('log redaction (A-17)', () => {
  test('scrub removes forbidden keys at any depth and cuts cycles', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    const out = scrub({
      text: 'secret words',
      nested: { adaptedText: 'x', ok: true, arr: [{ token: 't', keep: 1 }] },
      cyc,
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('text');
    expect((out['nested'] as Record<string, unknown>)['ok']).toBe(true);
    expect(out['nested'] as Record<string, unknown>).not.toHaveProperty('adaptedText');
    expect(
      ((out['nested'] as Record<string, unknown>)['arr'] as Record<string, unknown>[])[0],
    ).toEqual({ keep: 1 });
  });

  test('no log line contains transcript text, translations, signed URLs, tokens, or forbidden keys', async () => {
    const s = await login(app, 'redact@example.com', 'Redaction Org');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: s.headers,
      payload: { title: 'Ep' },
    });
    const projectId = created.json().project.id as string;
    await uploadSource(app, s, projectId, 'r.wav', makeWav(1));
    const w = new SimulatedWorker(app, 'test-worker-token');
    await w.drain();
    await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/segments`,
      headers: s.headers,
    });
    const job = await app.inject({
      method: 'POST',
      url: '/api/v1/localization-jobs',
      headers: { ...s.headers, 'idempotency-key': randomUUID() },
      payload: { projectId, targets: [{ locale: 'es-MX' }], acceptBetaTerms: true },
    });
    const targetId = job.json().targets[0].id as string;
    await w.drain();
    const review = await app.inject({
      method: 'GET',
      url: `/api/v1/target-jobs/${targetId}/review`,
      headers: s.headers,
    });
    const flagged = review.json().segments.find((x: { issues: unknown[] }) => x.issues.length > 0);
    await app.inject({
      method: 'POST',
      url: `/api/v1/target-jobs/${targetId}/segments/${flagged.segment.id}/regenerate`,
      headers: s.headers,
      payload: { stage: 'translation', hint: 'SECRET-HINT-TEXT' },
    });
    await w.drain();

    expect(lines.length).toBeGreaterThan(10);
    const joined = lines.join('\n');
    for (const forbidden of [
      'Welcome back to the show',
      '[es-MX] Welcome',
      'SECRET-HINT-TEXT',
      s.token,
      'signature=',
      'test-worker-token',
    ]) {
      expect(joined, `log contains ${forbidden}`).not.toContain(forbidden);
    }
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const walk = (v: unknown, path: string) => {
        if (v && typeof v === 'object') {
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            expect(isForbiddenKey(k), `${path}.${k}`).toBe(false);
            walk(val, `${path}.${k}`);
          }
        }
      };
      walk(obj, 'line');
    }
  });
});
