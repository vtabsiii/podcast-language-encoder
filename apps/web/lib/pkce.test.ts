import { describe, expect, it } from 'vitest';
import { base64url, codeChallenge, generateCodeVerifier, generateState } from './pkce';

const UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

describe('pkce', () => {
  it('generates a 43-char base64url verifier from 32 bytes', () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(UNRESERVED);
    expect(v).not.toContain('=');
  });

  it('supports longer verifiers up to the RFC 7636 limit of 128 chars', () => {
    const v = generateCodeVerifier(96);
    expect(v).toHaveLength(128);
    expect(v).toMatch(UNRESERVED);
    expect(() => generateCodeVerifier(16)).toThrow(RangeError);
    expect(() => generateCodeVerifier(97)).toThrow(RangeError);
  });

  it('is random', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    expect(generateState()).not.toBe(generateState());
    expect(generateState()).toMatch(UNRESERVED);
  });

  it('computes the S256 challenge from the RFC 7636 appendix B vector', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('base64url uses the URL-safe alphabet without padding', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(base64url(new Uint8Array([0xff]))).toBe('_w');
  });
});
