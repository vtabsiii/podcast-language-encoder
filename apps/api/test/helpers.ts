import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createDb, type Db } from '../src/db/pool.js';

export const TEST_DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://polycast:polycast@127.0.0.1:5432/polycast';
export const TEST_APP_DATABASE_URL =
  process.env['DATABASE_APP_URL'] ?? 'postgres://polycast_app:polycast_app@127.0.0.1:5432/polycast';

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_APP_URL: TEST_APP_DATABASE_URL,
    LOCAL_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'polycast-storage-')),
    PUBLIC_API_URL: 'http://127.0.0.1:4000',
    SIGNED_URL_TTL_SECONDS: '900',
    WORKER_TOKEN: 'test-worker-token',
    TASK_MAX_ATTEMPTS: '2',
    ...overrides,
  });
}

const TABLES = [
  'stage_tasks',
  'idempotency_keys',
  'domain_events',
  'audit_events',
  'provenance_manifests',
  'deliverables',
  'approvals',
  'comments',
  'reviews',
  'qc_issues',
  'qc_checks',
  'renders',
  'voice_assignments',
  'translation_versions',
  'target_jobs',
  'localization_jobs',
  'segments',
  'source_transcripts',
  'speakers',
  'uploads',
  'assets',
  'projects',
  'memberships',
  'users',
  'organizations',
];

/** Rebuild the schema from the migrations so edits to migrations/*.sql always take effect. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.owner.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;',
  );
  await migrate(db.owner, { createAppRole: true });
  await db.owner.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
}

export async function startTestApp(
  overrides: Partial<Record<string, string>> = {},
): Promise<TestApp> {
  const config = testConfig(overrides);
  const db = createDb(config);
  await resetDatabase(db);
  const app = await buildApp({ config, db, logger: false });
  await app.ready();
  return { app, db, config };
}

export async function stopTestApp(t: TestApp): Promise<void> {
  await t.app.close();
  await t.db.close();
}

export interface Session {
  token: string;
  organizationId: string;
  userId: string;
  headers: Record<string, string>;
}

export async function login(
  app: FastifyInstance,
  email: string,
  organizationName?: string,
  role?: string,
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: {
      email,
      displayName: email.split('@')[0],
      ...(organizationName ? { organizationName } : {}),
      ...(role ? { role } : {}),
    },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as {
    accessToken: string;
    organization: { id: string };
    user: { id: string };
  };
  return {
    token: body.accessToken,
    organizationId: body.organization.id,
    userId: body.user.id,
    headers: { authorization: `Bearer ${body.accessToken}` },
  };
}

/** A tiny deterministic WAV (16 kHz mono, 16-bit) of `seconds` length. */
export function makeWav(seconds: number, hz = 440): Buffer {
  const rate = 16_000;
  const frames = rate * seconds;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12_000);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Upload `bytes` for a project through the public upload API and signed local-storage URLs. */
export async function uploadSource(
  app: FastifyInstance,
  s: Session,
  projectId: string,
  fileName: string,
  bytes: Buffer,
  contentType = 'audio/wav',
) {
  const init = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: s.headers,
    payload: { projectId, fileName, contentType, byteSize: bytes.length },
  });
  if (init.statusCode !== 200) throw new Error(`init failed: ${init.body}`);
  const { uploadId, assetId, partSizeBytes, partCount } = init.json() as {
    uploadId: string;
    assetId: string;
    partSizeBytes: number;
    partCount: number;
  };
  const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
  const signed = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/parts`,
    headers: s.headers,
    payload: { partNumbers },
  });
  const parts: { partNumber: number; etag: string }[] = [];
  for (const part of (signed.json() as { parts: { partNumber: number; url: string }[] }).parts) {
    const u = new URL(part.url);
    const chunk = bytes.subarray(
      (part.partNumber - 1) * partSizeBytes,
      part.partNumber * partSizeBytes,
    );
    const put = await app.inject({
      method: 'PUT',
      url: u.pathname + u.search,
      payload: chunk,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (put.statusCode !== 200)
      throw new Error(`part upload failed: ${put.statusCode} ${put.body}`);
    parts.push({ partNumber: part.partNumber, etag: put.headers['etag'] as string });
  }
  const complete = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/complete`,
    headers: s.headers,
    payload: { parts },
  });
  if (complete.statusCode !== 200) throw new Error(`complete failed: ${complete.body}`);
  return { uploadId, assetId, status: complete.json() as { assetStatus: string } };
}
