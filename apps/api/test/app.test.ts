import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ErrorEnvelopeSchema, LanguageCapabilitiesResponseSchema } from '@polycast/contracts';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), logger: false });
  await app.ready();
});
afterAll(async () => app.close());

describe('api', () => {
  test('healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  test('capabilities list all seed locales, none production', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities/languages' });
    expect(res.statusCode).toBe(200);
    const body = LanguageCapabilitiesResponseSchema.parse(res.json());
    expect(body.region).toBe('us-east-1');
    expect(body.locales.length).toBeGreaterThanOrEqual(15);
    for (const l of body.locales)
      for (const t of Object.values(l.tiers)) expect(t).not.toBe('production');
  });

  test('capabilities filtered to production is empty; bad tier is a validation error', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities/languages?kind=lipSync&minTier=production',
    });
    expect(ok.json().locales).toEqual([]);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities/languages?kind=lipSync&minTier=gold',
    });
    expect(bad.statusCode).toBe(400);
    const env = ErrorEnvelopeSchema.parse(bad.json());
    expect(env.code).toBe('VALIDATION_FAILED');
    expect(env.correlationId).toBe(bad.headers['x-request-id']);
  });

  test('unknown routes return the standard envelope and echo X-Request-Id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'corr-123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', correlationId: 'corr-123' });
  });

  test('openapi document is generated', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    // The /api/v1 prefix is expressed as the OpenAPI server base path.
    expect(res.json().servers[0].url).toBe('/api/v1');
    expect(res.json().paths['/capabilities/languages']).toBeDefined();
  });
});

describe('config', () => {
  test('production refuses to start with local/mock configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/Refusing to start in production/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PROVIDER_MODE: 'aws',
        DATABASE_URL: 'postgres://x',
        MEDIA_BUCKET_SOURCE: 'a',
        MEDIA_BUCKET_DELIVERABLES: 'b',
        COGNITO_USER_POOL_ID: 'c',
      }),
    ).not.toThrow();
  });
});
