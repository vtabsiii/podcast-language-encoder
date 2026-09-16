import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { createDb, type Db } from '../src/db/pool.js';
import { TEST_APP_DATABASE_URL, testConfig } from './helpers.js';

/**
 * The app role is created on the first run and its password realigned on every later run
 * (Secrets Manager rotation in AWS). The realignment must work for a non-superuser owner such
 * as an RDS master user, so it only touches LOGIN/PASSWORD, and it must never surface the
 * password in an error.
 */
describe('migrate: application role', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(testConfig());
  });
  afterAll(async () => {
    // Leave the dev password in place for the other suites.
    await migrate(db.owner, { createAppRole: true, appRolePassword: 'polycast_app' });
    await db.close();
  });

  test('realigns the password on repeated runs and keeps the role unprivileged', async () => {
    await migrate(db.owner, { createAppRole: true, appRolePassword: "rotated'1" });
    await migrate(db.owner, { createAppRole: true, appRolePassword: "rotated'1" });
    const url = new URL(TEST_APP_DATABASE_URL);
    url.password = "rotated'1";
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await client.end();
    }
    // The session setting used to pass the password is cleared afterwards.
    const owner = await db.owner.connect();
    try {
      const { rows } = await owner.query<{ v: string }>(
        "SELECT current_setting('polycast.app_role_password', true) AS v",
      );
      expect(rows[0]?.v ?? '').toBe('');
    } finally {
      owner.release();
    }
  });
});
