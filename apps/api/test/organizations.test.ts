import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ErrorEnvelopeSchema } from '@polycast/contracts';
import { signToken } from '../src/auth/jwt.js';
import { login, startTestApp, stopTestApp, type TestApp } from './helpers.js';

let t: TestApp;

/** A Cognito-shaped token for a subject the database has never seen (no memberships claimed). */
function freshToken(sub: string, email: string, name?: string): string {
  return signToken(
    { sub, email, name: name ?? '', org_ids: [], role: 'viewer' },
    t.config.LOCAL_JWT_SECRET,
    3600,
  );
}

beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await stopTestApp(t);
});

describe('first sign-in (just-in-time provisioning)', () => {
  test('an unseen subject gets a users row and /me is 403 until an organization exists', async () => {
    const token = freshToken('cognito:sub-new-1', 'New.Person@Example.com', 'New Person');
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(403);
    const env = ErrorEnvelopeSchema.parse(me.json());
    expect(env.code).toBe('FORBIDDEN');
    expect(env.message).toBe('No organization membership');

    const rows = await t.db.withSystem(
      async (tx) =>
        (
          await tx.query<{ email: string; display_name: string }>(
            'SELECT email, display_name FROM users WHERE identity_subject = $1',
            ['cognito:sub-new-1'],
          )
        ).rows,
    );
    expect(rows).toEqual([{ email: 'new.person@example.com', display_name: 'New Person' }]);

    // A second request with the same subject does not create a second user.
    await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const count = await t.db.withSystem(
      async (tx) =>
        (
          await tx.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM users WHERE identity_subject = $1',
            ['cognito:sub-new-1'],
          )
        ).rows[0]?.n,
    );
    expect(count).toBe('1');
  });

  test('display name falls back to the email local part', async () => {
    const token = freshToken('cognito:sub-new-2', 'someone@example.com');
    await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const row = await t.db.withSystem(
      async (tx) =>
        (
          await tx.query<{ display_name: string }>(
            'SELECT display_name FROM users WHERE identity_subject = $1',
            ['cognito:sub-new-2'],
          )
        ).rows[0],
    );
    expect(row?.display_name).toBe('someone');
  });

  test('a token without an email cannot be provisioned', async () => {
    const token = freshToken('cognito:sub-no-email', '');
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/v1/organizations', () => {
  test('a member-less identity creates its first organization and becomes owner', async () => {
    const token = freshToken('cognito:sub-founder', 'founder@example.com', 'Founder');
    const headers = { authorization: `Bearer ${token}` };

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers,
      payload: { name: 'Founder Media' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      organization: { id: string; name: string; status: string };
      role: string;
    };
    expect(body.role).toBe('owner');
    expect(body.organization.name).toBe('Founder Media');
    expect(body.organization.status).toBe('active');

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as {
      organization: { id: string };
      role: string;
      permissions: string[];
      memberships: { organization: { id: string }; role: string }[];
    };
    expect(meBody.organization.id).toBe(body.organization.id);
    expect(meBody.role).toBe('owner');
    expect(meBody.permissions).toContain('org:manage');
    expect(meBody.memberships).toEqual([
      { organization: expect.objectContaining({ id: body.organization.id }), role: 'owner' },
    ]);

    // Audit rows are tenant-scoped (RLS), so read them as that tenant.
    const audit = await t.db.withTenant(
      { organizationId: body.organization.id, userId: null },
      async (tx) =>
        (
          await tx.query<{ action: string; actor_user_id: string | null }>(
            'SELECT action, actor_user_id FROM audit_events WHERE organization_id = $1',
            [body.organization.id],
          )
        ).rows,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('organization.created');
    expect(audit[0]?.actor_user_id).toBeTruthy();
  });

  test('an existing member can create a second organization and switch to it', async () => {
    const s = await login(t.app, 'owner-x@example.com', 'Org X');
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: s.headers,
      payload: { name: 'Org Y' },
    });
    expect(created.statusCode).toBe(201);
    const newOrgId = (created.json() as { organization: { id: string } }).organization.id;
    expect(newOrgId).not.toBe(s.organizationId);

    // The token still defaults to the original organization …
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: s.headers });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as {
      organization: { id: string };
      memberships: { organization: { id: string }; role: string }[];
    };
    expect(meBody.organization.id).toBe(s.organizationId);
    expect(meBody.memberships.map((m) => m.organization.id).sort()).toEqual(
      [s.organizationId, newOrgId].sort(),
    );

    // … and X-Organization-Id selects the new one.
    const switched = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...s.headers, 'x-organization-id': newOrgId },
    });
    expect(switched.statusCode).toBe(200);
    expect(
      (switched.json() as { organization: { id: string }; role: string }).organization.id,
    ).toBe(newOrgId);
    expect((switched.json() as { role: string }).role).toBe('owner');
  });

  test('requires a token (401) and a non-empty name (400)', async () => {
    const anon = await t.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      payload: { name: 'Nobody Inc' },
    });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().code).toBe('UNAUTHENTICATED');

    const token = freshToken('cognito:sub-validation', 'validation@example.com');
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '   ' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('VALIDATION_FAILED');
  });

  test('membership-only routes stay 403 for an identity without membership', async () => {
    const token = freshToken('cognito:sub-lurker', 'lurker@example.com');
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'No organization membership',
    });
  });
});
