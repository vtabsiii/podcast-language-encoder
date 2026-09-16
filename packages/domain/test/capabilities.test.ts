import { describe, expect, test } from 'vitest';
import { SEED_LOCALES, assertNoProductionInSeed, createRegistry } from '../src/index.js';

describe('capability registry', () => {
  test('seed contains the 15 launch languages and no production tier', () => {
    const languages = new Set(SEED_LOCALES.map((l) => l.language));
    expect([...languages].sort()).toEqual(
      [
        'ar',
        'bn',
        'de',
        'en',
        'es',
        'fr',
        'hi',
        'id',
        'ja',
        'ko',
        'pt',
        'ru',
        'tr',
        'ur',
        'zh',
      ].sort(),
    );
    expect(() => assertNoProductionInSeed()).not.toThrow();
  });

  test('locale tags are unique and BCP 47 shaped', () => {
    const tags = SEED_LOCALES.map((l) => l.locale);
    expect(new Set(tags).size).toBe(tags.length);
    for (const t of tags) expect(t).toMatch(/^[a-z]{2}-[A-Z0-9]{2,3}$/);
  });

  test('RTL locales are flagged', () => {
    const reg = createRegistry();
    expect(reg.get('ar-SA')?.direction).toBe('rtl');
    expect(reg.get('ur-PK')?.direction).toBe('rtl');
    expect(reg.get('de-DE')?.direction).toBe('ltr');
  });

  test('selectable(production) is empty for the seed; selectable(beta) lists everything by priority', () => {
    const reg = createRegistry();
    expect(reg.selectable('lipSync', 'production')).toHaveLength(0);
    const beta = reg.selectable('speech', 'beta');
    expect(beta).toHaveLength(SEED_LOCALES.length);
    expect(beta[0]?.locale).toBe('en-GB'); // priority 1, alphabetical before en-US
  });

  test('guard rejects a promoted seed', () => {
    const promoted = SEED_LOCALES.map((l) =>
      l.locale === 'de-DE' ? { ...l, tiers: { ...l.tiers, speech: 'production' as const } } : l,
    );
    expect(() => assertNoProductionInSeed(promoted)).toThrow(/de-DE/);
  });
});
