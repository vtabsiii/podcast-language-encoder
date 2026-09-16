import 'server-only';
import { z } from 'zod';
import { CALLBACK_PATH, LOGOUT_PATH, publicOrigin, type CognitoConfig } from './auth-config';

/**
 * Cognito hosted-UI OAuth 2.0 endpoints (authorization code grant with PKCE, public client).
 * Nothing here logs: request bodies and responses carry codes and tokens.
 */

const TokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export class TokenEndpointError extends Error {
  override readonly name = 'TokenEndpointError';
  constructor(
    public readonly status: number,
    /** OAuth `error` code from the response body when present; never the description. */
    public readonly code: string | null,
  ) {
    super(`Token endpoint responded with HTTP ${status}${code ? ` (${code})` : ''}`);
  }
}

export function redirectUri(config: CognitoConfig, requestOrigin: string): string {
  return `${publicOrigin(config, requestOrigin)}${CALLBACK_PATH}`;
}

export function logoutUri(config: CognitoConfig, requestOrigin: string): string {
  return `${publicOrigin(config, requestOrigin)}${LOGOUT_PATH}?done=1`;
}

export function authorizeUrl(
  config: CognitoConfig,
  params: { state: string; codeChallenge: string; redirectUri: string },
): string {
  const url = new URL(`${config.hostedUiUrl}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function hostedLogoutUrl(config: CognitoConfig, params: { logoutUri: string }): string {
  const url = new URL(`${config.hostedUiUrl}/logout`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', params.logoutUri);
  return url.toString();
}

async function postToken(config: CognitoConfig, form: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${config.hostedUiUrl}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
    cache: 'no-store',
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null;
    throw new TokenEndpointError(res.status, code);
  }
  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new TokenEndpointError(res.status, 'malformed_response');
  return parsed.data;
}

export function exchangeCode(
  config: CognitoConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenResponse> {
  return postToken(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  );
}

/** A refresh response carries no new refresh token; callers keep the existing one. */
export function refreshTokens(config: CognitoConfig, refreshToken: string): Promise<TokenResponse> {
  return postToken(
    config,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    }),
  );
}
