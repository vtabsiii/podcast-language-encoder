import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/pool.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
const db = createDb(config);
// Test harnesses (Playwright) start from an empty schema. Refused outside development/test.
if (process.env['POLYCAST_RESET_SCHEMA'] === '1' && config.NODE_ENV !== 'production') {
  await db.owner.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;',
  );
}
// Outside production the API owns its schema; in AWS the migration job runs before deploy (M2).
const applied = await migrate(db.owner, { createAppRole: config.NODE_ENV !== 'production' });
const app = await buildApp({ config, db });
if (applied.length) app.log.info({ applied }, 'migrations applied');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
