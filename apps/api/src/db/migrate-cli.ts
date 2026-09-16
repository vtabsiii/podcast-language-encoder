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
  // In AWS the app role's password comes from Secrets Manager (DB_APP_PASSWORD); the migration
  // creates the role on first run and realigns the password after every rotation.
  const appPassword = config.DB_APP_PASSWORD;
  const applied = await migrate(db.owner, {
    createAppRole: config.NODE_ENV !== 'production' || Boolean(appPassword),
    ...(appPassword ? { appRolePassword: appPassword } : {}),
  });
  console.log(JSON.stringify({ applied }));
} catch (err) {
  // Only the message: a database error object carries the failing statement (`where`), which
  // may contain credentials, and this output lands in CloudWatch and deploy logs.
  console.error(`migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
