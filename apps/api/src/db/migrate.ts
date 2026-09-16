import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export interface MigrateOptions {
  /** Create the least-privilege application role with a dev password. Never in production. */
  createAppRole?: boolean;
  appRolePassword?: string;
}

/** Apply every migrations/*.sql in lexical order, once. Idempotent. */
export async function migrate(owner: pg.Pool, opts: MigrateOptions = {}): Promise<string[]> {
  const client = await owner.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7212024)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    if (opts.createAppRole) {
      // Create the least-privilege role, or realign its password with the secret in use
      // (Secrets Manager rotation in AWS, the dev default locally). The password travels as a
      // bind parameter and the role statement runs inside a handler that re-raises without the
      // statement text, so neither a server log context nor a client-side error can echo it.
      // ALTER only touches LOGIN/PASSWORD: managed Postgres masters (RDS) are not superusers and
      // may not restate SUPERUSER/BYPASSRLS, even to keep them unset.
      const pw = opts.appRolePassword ?? 'polycast_app';
      await client.query("SELECT set_config('polycast.app_role_password', $1, false)", [pw]);
      try {
        await client.query(`DO $$ BEGIN
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'polycast_app') THEN
              EXECUTE format(
                'CREATE ROLE polycast_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L',
                current_setting('polycast.app_role_password'));
            ELSE
              EXECUTE format(
                'ALTER ROLE polycast_app WITH LOGIN PASSWORD %L',
                current_setting('polycast.app_role_password'));
            END IF;
          EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'could not create or realign role polycast_app: % (%)', SQLERRM, SQLSTATE;
          END;
        END $$;`);
      } finally {
        await client
          .query("SELECT set_config('polycast.app_role_password', '', false)")
          .catch(() => undefined);
      }
    }
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(migrationsDir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7212024)').catch(() => undefined);
    client.release();
  }
}
