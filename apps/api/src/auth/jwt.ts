import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@polycast/domain';

/**
 * Minimal HS256 JWT for the local auth adapter (A-14). Claims mirror Cognito's shape so the
 * principal resolver is identical in both modes: `sub`, `email`, `name`, `org_ids`, `role`.
 * Production uses AUTH_MODE=cognito with RS256/JWKS verification (M2); this module is never
 * used there.
 */
export interface TokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly org_ids: readonly string[];
  readonly role: string;
  readonly iat: number;
  readonly exp: number;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signToken(
  claims: Omit<TokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const payload: TokenClaims = { ...claims, iat, exp: iat + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string, now = Date.now()): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new DomainError('UNAUTHENTICATED', 'Malformed token');
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const given = fromB64url(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new DomainError('UNAUTHENTICATED', 'Invalid token signature');
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(fromB64url(body).toString('utf8')) as TokenClaims;
  } catch {
    throw new DomainError('UNAUTHENTICATED', 'Malformed token payload');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    throw new DomainError('UNAUTHENTICATED', 'Token expired');
  }
  if (typeof claims.sub !== 'string' || !Array.isArray(claims.org_ids)) {
    throw new DomainError('UNAUTHENTICATED', 'Token missing required claims');
  }
  return claims;
}
