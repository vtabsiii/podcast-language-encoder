import { z } from 'zod';

/**
 * Runtime configuration. Production fails closed: required providers/secrets must be present
 * and every "local" adapter must be switched off. Local development uses explicitly named
 * Mock/Local adapters.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  /** Externally reachable base URL of this API (signed local-storage URLs embed it). */
  PUBLIC_API_URL: z.string().url().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  /** Comma-separated allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /** "local" uses mock adapters; "aws" requires the provider variables below. */
  PROVIDER_MODE: z.enum(['local', 'aws']).default('local'),

  /** Owner connection used for migrations. */
  DATABASE_URL: z.string().optional(),
  /** Least-privilege connection used by request handlers (no BYPASSRLS, not table owner). */
  DATABASE_APP_URL: z.string().optional(),
  /** Alternative to the URLs: parts injected individually from Secrets Manager by ECS (M2). */
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().default('polycast'),
  DB_OWNER_USER: z.string().optional(),
  DB_OWNER_PASSWORD: z.string().optional(),
  DB_APP_USER: z.string().optional(),
  DB_APP_PASSWORD: z.string().optional(),
  DB_SSL: z.enum(['disable', 'require']).default('disable'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** "local" keeps objects on disk and signs URLs served by this API; "s3" is MinIO or AWS S3. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.polycast-data/storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  MEDIA_BUCKET_QUARANTINE: z.string().default('polycast-quarantine'),
  MEDIA_BUCKET_SOURCE: z.string().default('polycast-source'),
  MEDIA_BUCKET_DERIVED: z.string().default('polycast-derived'),
  MEDIA_BUCKET_DELIVERABLES: z.string().default('polycast-deliverables'),
  /** Signed URL lifetime; never above 15 minutes (NFR-001). */
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(900),

  /** "local" issues HS256 tokens from /auth/dev-login; "cognito" verifies the user pool's JWKS (M2). */
  AUTH_MODE: z.enum(['local', 'cognito']).default('local'),
  LOCAL_JWT_SECRET: z.string().min(16).default('polycast-local-dev-secret-not-for-production'),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 3600),

  /** Shared secret media workers present on the internal task endpoints. */
  WORKER_TOKEN: z.string().min(8).default('dev-worker-token'),
  TASK_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  TASK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** Run the in-process local orchestrator (Step Functions replaces it in AWS). */
  ORCHESTRATOR: z.enum(['local', 'step-functions']).default('local'),

  /** Market priority score version surfaced in capability responses. */
  PRIORITY_SCORE_VERSION: z.string().default('2026-Q3'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

function composeUrl(user: string, password: string, cfg: z.infer<typeof EnvSchema>): string {
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  const ssl = cfg.DB_SSL === 'require' ? '?sslmode=require' : '';
  return `postgres://${auth}@${cfg.DB_HOST}:${cfg.DB_PORT}/${cfg.DB_NAME}${ssl}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const cfg: AppConfig = {
    ...parsed,
    // ECS injects secret fields one by one; compose the URLs the pools expect.
    ...(parsed.DATABASE_URL === undefined && parsed.DB_HOST && parsed.DB_OWNER_USER && parsed.DB_OWNER_PASSWORD
      ? { DATABASE_URL: composeUrl(parsed.DB_OWNER_USER, parsed.DB_OWNER_PASSWORD, parsed) }
      : {}),
    ...(parsed.DATABASE_APP_URL === undefined && parsed.DB_HOST && parsed.DB_APP_USER && parsed.DB_APP_PASSWORD
      ? { DATABASE_APP_URL: composeUrl(parsed.DB_APP_USER, parsed.DB_APP_PASSWORD, parsed) }
      : {}),
  };
  if (cfg.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (cfg.PROVIDER_MODE !== 'aws') missing.push('PROVIDER_MODE=aws');
    if (cfg.STORAGE_DRIVER !== 's3') missing.push('STORAGE_DRIVER=s3');
    if (cfg.AUTH_MODE !== 'cognito') missing.push('AUTH_MODE=cognito');
    if (cfg.ORCHESTRATOR !== 'step-functions') missing.push('ORCHESTRATOR=step-functions');
    if (cfg.WORKER_TOKEN === 'dev-worker-token') missing.push('WORKER_TOKEN');
    if (cfg.LOCAL_JWT_SECRET.startsWith('polycast-local-dev')) missing.push('LOCAL_JWT_SECRET');
    for (const k of [
      'DATABASE_URL',
      'DATABASE_APP_URL',
      'PUBLIC_API_URL',
      'MEDIA_BUCKET_SOURCE',
      'MEDIA_BUCKET_DELIVERABLES',
      'COGNITO_USER_POOL_ID',
    ] as const) {
      if (!cfg[k]) missing.push(k);
    }
    if (missing.length) {
      throw new Error(
        `Refusing to start in production with mock/local configuration. Missing: ${missing.join(', ')}`,
      );
    }
  }
  return cfg;
}

/** Default local database URLs (docker-compose / CI service). */
export const DEFAULT_DATABASE_URL = 'postgres://polycast:polycast@127.0.0.1:5432/polycast';
export const DEFAULT_DATABASE_APP_URL =
  'postgres://polycast_app:polycast_app@127.0.0.1:5432/polycast';
