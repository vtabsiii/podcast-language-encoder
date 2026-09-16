import { writeFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/pool.js';

/**
 * Emits openapi.json. Route registration needs service wiring, so a database handle is
 * created but never connected (no queries run before `ready`).
 */
const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
const db = createDb(config);
const app = await buildApp({ config, db, logger: false });
// `ready` would start the LISTEN client; the swagger document is available before that.
try {
  await app.ready();
} catch {
  // no database in CI: the document is complete without the LISTEN client
}
writeFileSync('openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close().catch(() => undefined);
await db.close().catch(() => undefined);
console.log('wrote openapi.json');
