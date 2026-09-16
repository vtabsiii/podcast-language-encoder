import { loadConfig } from '../config.js';
import { createDb } from './pool.js';
import { migrate } from './migrate.js';

/**
 * `node dist/db/migrate-cli.js`: applies pending migrations with the owner connection. In AWS this
 * runs as a one-off ECS task before a deploy (docs/aws-setup.md); locally the API server does it
 * on boot. Outside production it also creates the least-privilege application role.
 */
const config = loadConfig();
const db = createDb(config);
try {
  const applied = await migrate(db.owner, {
    createAppRole: config.NODE_ENV !== 'production',
    ...(process.env['DB_APP_PASSWORD'] ? { appRolePassword: process.env['DB_APP_PASSWORD'] } : {}),
  });
  console.log(JSON.stringify({ applied }));
} finally {
  await db.close();
}
