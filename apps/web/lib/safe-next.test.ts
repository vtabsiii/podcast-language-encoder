import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

describe('safeNext', () => {
  it('keeps relative, path-absolute targets', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/projects/abc?tab=review#x')).toBe('/projects/abc?tab=review#x');
  });

  it('falls back for absolute and protocol-relative targets', () => {
    expect(safeNext('https://evil.example/')).toBe('/');
    expect(safeNext('//evil.example/')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
  });

  it('falls back for empty, non-string, oversized or control-character input', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(null, '/projects')).toBe('/projects');
    expect(safeNext('')).toBe('/');
    expect(safeNext(['/a'])).toBe('/');
    expect(safeNext('/a\r\nSet-Cookie: x')).toBe('/');
    expect(safeNext(`/${'a'.repeat(3000)}`)).toBe('/');
  });
});
