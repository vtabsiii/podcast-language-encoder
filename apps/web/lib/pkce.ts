import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636) helpers for the Cognito hosted-UI authorization-code flow. Pure functions:
 * no cookies, no logging. Never log a verifier, challenge or state value.
 */

/** RFC 4648 §5 base64url without padding, the alphabet PKCE requires. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 32 random bytes → 43 base64url chars (RFC 7636 §4.1 allows 43–128 characters). */
export function generateCodeVerifier(byteLength = 32): string {
  if (byteLength < 32 || byteLength > 96) {
    throw new RangeError('verifier must be built from 32–96 random bytes');
  }
  return base64url(randomBytes(byteLength));
}

/** S256 code challenge: base64url(sha256(ascii(verifier))). */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** Opaque CSRF token bound to one authorization request. */
export function generateState(): string {
  return base64url(randomBytes(24));
}
