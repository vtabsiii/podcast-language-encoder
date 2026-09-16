import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { DomainError } from '@polycast/domain';
import type { TokenClaims } from './jwt.js';

/**
 * Cognito access/ID token verification (AUTH_MODE=cognito, M2). RS256 against the user pool's
 * JWKS, cached and refreshed on unknown key ids. Claims are mapped to the same shape the local
 * adapter issues: the pre-token-generation trigger (infra/lambda/pre-token-generation) copies
 * `custom:org_ids` and `custom:role` into `org_ids` and `role`.
 */
export interface Jwks {
  keys: (JsonWebKey & { kid: string; alg?: string; use?: string })[];
}

export interface CognitoVerifierOptions {
  region: string;
  userPoolId: string;
  /** App client id; when set, `aud` (id tokens) or `client_id` (access tokens) must match. */
  clientId?: string | undefined;
  fetchJwks?: (url: string) => Promise<Jwks>;
  now?: () => number;
}

const b64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class CognitoVerifier {
  private keys = new Map<string, ReturnType<typeof createPublicKey>>();
  private lastFetch = 0;
  readonly issuer: string;
  readonly jwksUrl: string;

  constructor(private readonly opts: CognitoVerifierOptions) {
    this.issuer = `https://cognito-idp.${opts.region}.amazonaws.com/${opts.userPoolId}`;
    this.jwksUrl = `${this.issuer}/.well-known/jwks.json`;
  }

  private async refresh(): Promise<void> {
    const fetchJwks = this.opts.fetchJwks ?? defaultFetchJwks;
    const jwks = await fetchJwks(this.jwksUrl);
    this.keys = new Map(jwks.keys.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
    this.lastFetch = Date.now();
  }

  private async key(kid: string) {
    if (!this.keys.has(kid) && Date.now() - this.lastFetch > 60_000) await this.refresh();
    if (!this.keys.has(kid) && this.keys.size === 0) await this.refresh();
    const key = this.keys.get(kid);
    if (!key) throw new DomainError('UNAUTHENTICATED', 'Unknown signing key');
    return key;
  }

  async verify(token: string): Promise<TokenClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new DomainError('UNAUTHENTICATED', 'Malformed token');
    const [h, b, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64url(h).toString('utf8')) as { alg?: string; kid?: string };
      payload = JSON.parse(b64url(b).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Malformed token');
    }
    if (header.alg !== 'RS256' || !header.kid)
      throw new DomainError('UNAUTHENTICATED', 'Unsupported token algorithm');
    const key = await this.key(header.kid);
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${b}`), key, b64url(s));
    if (!ok) throw new DomainError('UNAUTHENTICATED', 'Invalid token signature');

    const now = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    if (typeof payload['exp'] !== 'number' || payload['exp'] <= now)
      throw new DomainError('UNAUTHENTICATED', 'Token expired');
    if (payload['iss'] !== this.issuer)
      throw new DomainError('UNAUTHENTICATED', 'Token issuer mismatch');
    if (this.opts.clientId) {
      const audience = payload['aud'] ?? payload['client_id'];
      if (audience !== this.opts.clientId)
        throw new DomainError('UNAUTHENTICATED', 'Token audience mismatch');
    }
    const sub = payload['sub'];
    if (typeof sub !== 'string') throw new DomainError('UNAUTHENTICATED', 'Token missing subject');
    const rawOrgs = payload['org_ids'] ?? payload['custom:org_ids'] ?? '[]';
    let orgIds: string[] = [];
    if (Array.isArray(rawOrgs)) orgIds = rawOrgs.map(String);
    else if (typeof rawOrgs === 'string') {
      try {
        const parsed = JSON.parse(rawOrgs) as unknown;
        orgIds = Array.isArray(parsed) ? parsed.map(String) : rawOrgs.split(/\s+/).filter(Boolean);
      } catch {
        orgIds = rawOrgs.split(/\s+/).filter(Boolean);
      }
    }
    return {
      sub,
      email: typeof payload['email'] === 'string' ? payload['email'] : '',
      name: typeof payload['name'] === 'string' ? payload['name'] : '',
      org_ids: orgIds,
      role:
        typeof payload['role'] === 'string'
          ? payload['role']
          : typeof payload['custom:role'] === 'string'
            ? payload['custom:role']
            : 'viewer',
      iat: typeof payload['iat'] === 'number' ? payload['iat'] : now,
      exp: payload['exp'],
    };
  }
}

async function defaultFetchJwks(url: string): Promise<Jwks> {
  const res = await fetch(url);
  if (!res.ok)
    throw new DomainError('PROVIDER_UNAVAILABLE', 'Could not fetch the identity provider keys', {
      retryable: true,
    });
  return (await res.json()) as Jwks;
}
