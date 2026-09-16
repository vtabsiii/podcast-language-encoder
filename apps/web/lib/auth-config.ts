import 'server-only';
import { z } from 'zod';

/**
 * Sign-in configuration, read from server-side env vars at request time (never NEXT_PUBLIC_).
 *
 * - `local` (default): the development form posts to the API's dev-login route.
 * - `cognito`: OAuth 2.0 authorization-code + PKCE against the Cognito hosted UI. The API
 *   verifies the resulting ID token, so every other page keeps working unchanged.
 */
const AuthModeSchema = z.enum(['local', 'cognito']);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export function authMode(): AuthMode {
  const raw = process.env.AUTH_MODE?.trim() || 'local';
  const parsed = AuthModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`AUTH_MODE must be "local" or "cognito" (got "${raw}")`);
  }
  return parsed.data;
}

const Url = z.string().trim().url();

const CognitoEnvSchema = z.object({
  COGNITO_CLIENT_ID: z.string().trim().min(1),
  COGNITO_HOSTED_UI_URL: Url,
  WEB_ORIGIN: Url.optional(),
});

export interface CognitoConfig {
  /** User pool app client id (public client, no secret). */
  clientId: string;
  /** Hosted UI base URL without trailing slash, e.g. https://x.auth.us-east-1.amazoncognito.com */
  hostedUiUrl: string;
  /** Public origin of this web app, or null to fall back to the request origin. */
  webOrigin: string | null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Validated Cognito settings. Throws a clear message listing what is missing or malformed. */
export function cognitoConfig(): CognitoConfig {
  const parsed = CognitoEnvSchema.safeParse({
    COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID || undefined,
    COGNITO_HOSTED_UI_URL: process.env.COGNITO_HOSTED_UI_URL || undefined,
    WEB_ORIGIN: process.env.WEB_ORIGIN || undefined,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `AUTH_MODE=cognito needs COGNITO_CLIENT_ID, COGNITO_HOSTED_UI_URL and (recommended) ` +
        `WEB_ORIGIN. Problems: ${problems.join('; ')}`,
    );
  }
  return {
    clientId: parsed.data.COGNITO_CLIENT_ID,
    hostedUiUrl: stripTrailingSlash(parsed.data.COGNITO_HOSTED_UI_URL),
    webOrigin: parsed.data.WEB_ORIGIN ? stripTrailingSlash(parsed.data.WEB_ORIGIN) : null,
  };
}

/** Origin used for redirect_uri / logout_uri: WEB_ORIGIN when set, else the request's origin. */
export function publicOrigin(config: CognitoConfig, requestOrigin: string): string {
  return config.webOrigin ?? stripTrailingSlash(requestOrigin);
}

export const CALLBACK_PATH = '/auth/callback';
export const LOGOUT_PATH = '/logout';
