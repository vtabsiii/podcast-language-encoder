import { describe, expect, test } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { CognitoVerifier, type Jwks } from '../src/auth/cognito.js';
import { loadConfig } from '../src/config.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as Jwks['keys'][number];
const jwks: Jwks = { keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const issuer = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST';

function sign(payload: Record<string, unknown>, kid = 'k1'): string {
  const head = b64({ alg: 'RS256', kid });
  const body = b64(payload);
  const sig = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(privateKey)
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

describe('cognito verifier', () => {
  const verifier = new CognitoVerifier({
    region: 'us-east-1',
    userPoolId: 'us-east-1_TEST',
    clientId: 'client-1',
    fetchJwks: async () => jwks,
  });
  const now = Math.floor(Date.now() / 1000);

  test('accepts a valid token and maps the org claims', async () => {
    const token = sign({
      sub: 'abc',
      iss: issuer,
      aud: 'client-1',
      exp: now + 60,
      iat: now,
      email: 'a@b.c',
      name: 'A',
      org_ids: '["o1","o2"]',
      role: 'producer',
    });
    const claims = await verifier.verify(token);
    expect(claims.org_ids).toEqual(['o1', 'o2']);
    expect(claims.role).toBe('producer');
    expect(claims.email).toBe('a@b.c');
  });

  test('accepts space-separated custom attributes as issued by the pre-token trigger fallback', async () => {
    const token = sign({
      sub: 'abc',
      iss: issuer,
      client_id: 'client-1',
      token_use: 'access',
      exp: now + 60,
      'custom:org_ids': 'o1 o2',
      'custom:role': 'reviewer',
    });
    const claims = await verifier.verify(token);
    expect(claims.org_ids).toEqual(['o1', 'o2']);
    expect(claims.role).toBe('reviewer');
  });

  test('rejects bad signatures, wrong issuer, wrong audience, expiry, and unknown kid', async () => {
    const good = sign({ sub: 'abc', iss: issuer, aud: 'client-1', exp: now + 60 });
    await expect(verifier.verify(good.slice(0, -4) + 'AAAA')).rejects.toThrow(/signature/);
    await expect(
      verifier.verify(sign({ sub: 'abc', iss: 'https://evil', aud: 'client-1', exp: now + 60 })),
    ).rejects.toThrow(/issuer/);
    await expect(
      verifier.verify(sign({ sub: 'abc', iss: issuer, aud: 'other', exp: now + 60 })),
    ).rejects.toThrow(/audience/);
    await expect(
      verifier.verify(sign({ sub: 'abc', iss: issuer, aud: 'client-1', exp: now - 1 })),
    ).rejects.toThrow(/expired/);
    await expect(
      verifier.verify(sign({ sub: 'abc', iss: issuer, aud: 'client-1', exp: now + 60 }, 'nope')),
    ).rejects.toThrow(/signing key/);
  });
});

describe('database url composition from secret parts (ECS)', () => {
  test('composes owner and app urls when the URL variables are absent', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      DB_HOST: 'db.internal',
      DB_OWNER_USER: 'polycast',
      DB_OWNER_PASSWORD: 'p@ss/word',
      DB_APP_USER: 'polycast_app',
      DB_APP_PASSWORD: 'app',
      DB_SSL: 'require',
    });
    expect(cfg.DATABASE_URL).toBe(
      'postgres://polycast:p%40ss%2Fword@db.internal:5432/polycast?sslmode=require',
    );
    expect(cfg.DATABASE_APP_URL).toBe(
      'postgres://polycast_app:app@db.internal:5432/polycast?sslmode=require',
    );
  });
  test('explicit URLs win over parts', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      DB_HOST: 'h',
      DB_OWNER_USER: 'u',
      DB_OWNER_PASSWORD: 'p',
    });
    expect(cfg.DATABASE_URL).toBe('postgres://x');
  });
});
