import { describe, expect, test } from 'vitest';
import { hasPermission, isUuidv7, uuidv7, uuidv7Timestamp } from '../src/index.js';

describe('uuidv7', () => {
  test('is well formed and sortable by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isUuidv7(a)).toBe(true);
    expect(uuidv7Timestamp(a)).toBe(1_700_000_000_000);
    expect(a < b).toBe(true);
  });
  test('is unique across many calls in the same millisecond', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(1)));
    expect(ids.size).toBe(5000);
  });
});

describe('roles', () => {
  test('permissions nest from viewer up to owner', () => {
    expect(hasPermission('viewer', 'project:read')).toBe(true);
    expect(hasPermission('viewer', 'job:create')).toBe(false);
    expect(hasPermission('reviewer', 'review:approve')).toBe(true);
    expect(hasPermission('reviewer', 'project:create')).toBe(false);
    expect(hasPermission('producer', 'job:create')).toBe(true);
    expect(hasPermission('producer', 'members:manage')).toBe(false);
    expect(hasPermission('admin', 'consent:manage')).toBe(true);
    expect(hasPermission('admin', 'org:billing')).toBe(false);
    expect(hasPermission('owner', 'org:billing')).toBe(true);
  });
});
