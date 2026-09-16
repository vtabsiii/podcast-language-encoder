import { z } from 'zod';

/**
 * Runtime configuration. Production fails closed: required providers/secrets must be present.
 * Local development uses explicitly named Mock/Local adapters.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  AWS_REGION: z.string().default('us-east-1'),
  /** Comma-separated allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /** "local" uses mock adapters; "aws" requires the provider variables below. */
  PROVIDER_MODE: z.enum(['local', 'aws']).default('local'),
  DATABASE_URL: z.string().optional(),
  MEDIA_BUCKET_SOURCE: z.string().optional(),
  MEDIA_BUCKET_DELIVERABLES: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  /** Market priority score version surfaced in capability responses. */
  PRIORITY_SCORE_VERSION: z.string().default('2026-Q3'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cfg = EnvSchema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (cfg.PROVIDER_MODE !== 'aws') missing.push('PROVIDER_MODE=aws');
    for (const k of [
      'DATABASE_URL',
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
