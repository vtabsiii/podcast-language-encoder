import pg from 'pg';
import type { AppConfig } from '../config.js';
import { DEFAULT_DATABASE_APP_URL, DEFAULT_DATABASE_URL } from '../config.js';

const { Pool, types } = pg;
// bigint columns (media time in µs) come back as JS numbers; 2^53 µs ≈ 285 years.
types.setTypeParser(20, (v: string) => Number(v));

export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface TenantContext {
  readonly organizationId: string;
  readonly userId: string | null;
}

export interface Db {
  /** Owner pool: migrations only. */
  readonly owner: pg.Pool;
  /** Least-privilege pool used by every request and by the orchestrator. */
  readonly app: pg.Pool;
  /**
   * Run `fn` inside a transaction scoped to one tenant. Row-level security policies read
   * `app.org_id` / `app.user_id`, so nothing inside can see another organization's rows.
   */
  withTenant<T>(ctx: TenantContext, fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Transaction without tenant scope: only system tables (no RLS) and cross-tenant reads by user. */
  withSystem<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(config: AppConfig): Db {
  const owner = new Pool({ connectionString: config.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 2 });
  const app = new Pool({
    connectionString: config.DATABASE_APP_URL ?? DEFAULT_DATABASE_APP_URL,
    max: config.DATABASE_POOL_MAX,
  });

  async function inTx<T>(
    setup: (c: pg.PoolClient) => Promise<void>,
    fn: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await setup(client);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    owner,
    app,
    withTenant: (ctx, fn) =>
      inTx(async (c) => {
        // set_config with is_local=true scopes the setting to this transaction.
        await c.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
          [ctx.organizationId, ctx.userId ?? ''],
        );
      }, fn),
    withSystem: (fn) =>
      inTx(async (c) => {
        await c.query(
          "SELECT set_config('app.org_id', '', true), set_config('app.user_id', '', true)",
        );
      }, fn),
    close: async () => {
      await Promise.all([owner.end(), app.end()]);
    },
  };
}
