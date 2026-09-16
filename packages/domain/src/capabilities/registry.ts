/**
 * Language capability registry.
 *
 * Language availability is data, not UI constants. A locale is selectable for a given
 * capability (transcription, translation, speech, lipSync) only at the tier recorded here,
 * and "production" may only be set by the benchmark promotion process
 * (docs/quality-benchmark.md). The seed below marks every target locale as `beta`,
 * which the UI must render with a review-required warning.
 */

export const CAPABILITY_TIERS = ['production', 'beta', 'unavailable'] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export const CAPABILITY_KINDS = ['transcription', 'translation', 'speech', 'lipSync'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export type TextDirection = 'ltr' | 'rtl';

export interface LocaleCapability {
  /** BCP 47 tag, e.g. "es-MX". */
  readonly locale: string;
  /** ISO 639-1 language code, e.g. "es". */
  readonly language: string;
  /** Human-readable name in English. */
  readonly displayName: string;
  /** Endonym, used in the language picker alongside displayName. */
  readonly nativeName: string;
  readonly direction: TextDirection;
  /** Whether the locale must be chosen explicitly (no "universal" fallback). */
  readonly requiresLocaleChoice: boolean;
  /** Market priority rank from the versioned market priority score (1 = highest). */
  readonly priority: number;
  /** Per-capability tier. */
  readonly tiers: Readonly<Record<CapabilityKind, CapabilityTier>>;
  /** Free-text product note surfaced to admins. */
  readonly note?: string;
}

const beta: Readonly<Record<CapabilityKind, CapabilityTier>> = {
  transcription: 'beta',
  translation: 'beta',
  speech: 'beta',
  lipSync: 'beta',
};

function locale(
  tag: string,
  displayName: string,
  nativeName: string,
  priority: number,
  opts: Partial<
    Pick<LocaleCapability, 'direction' | 'requiresLocaleChoice' | 'tiers' | 'note'>
  > = {},
): LocaleCapability {
  const language = tag.split('-')[0] ?? tag;
  return {
    locale: tag,
    language,
    displayName,
    nativeName,
    direction: opts.direction ?? 'ltr',
    requiresLocaleChoice: opts.requiresLocaleChoice ?? false,
    priority,
    tiers: opts.tiers ?? beta,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  };
}

/**
 * Seed registry (market priority score v1, see docs/product-spec.md §4).
 * Every target is beta until it passes the end-to-end benchmark.
 */
export const SEED_LOCALES: readonly LocaleCapability[] = [
  locale('en-US', 'English (United States)', 'English (US)', 1, {
    note: 'Default source locale. Target tier stays beta until the English re-voice benchmark passes.',
  }),
  locale('en-GB', 'English (United Kingdom)', 'English (UK)', 1),
  locale('es-419', 'Spanish (Latin America)', 'Español (Latinoamérica)', 2, {
    requiresLocaleChoice: true,
  }),
  locale('es-MX', 'Spanish (Mexico)', 'Español (México)', 2, { requiresLocaleChoice: true }),
  locale('es-ES', 'Spanish (Spain)', 'Español (España)', 2, { requiresLocaleChoice: true }),
  locale('zh-CN', 'Chinese (Simplified, China)', '中文（简体）', 3, {
    note: 'Simplified captions. Mainland distribution requires a separate compliance review.',
  }),
  locale('hi-IN', 'Hindi (India)', 'हिन्दी', 4, {
    note: 'Hinglish and named entities need glossary support.',
  }),
  locale('ar-001', 'Arabic (Modern Standard)', 'العربية', 5, {
    direction: 'rtl',
    requiresLocaleChoice: true,
  }),
  locale('ar-SA', 'Arabic (Saudi Arabia)', 'العربية (السعودية)', 5, {
    direction: 'rtl',
    requiresLocaleChoice: true,
  }),
  locale('pt-BR', 'Portuguese (Brazil)', 'Português (Brasil)', 6, { requiresLocaleChoice: true }),
  locale('pt-PT', 'Portuguese (Portugal)', 'Português (Portugal)', 6, {
    requiresLocaleChoice: true,
  }),
  locale('fr-FR', 'French (France)', 'Français (France)', 7, { requiresLocaleChoice: true }),
  locale('fr-CA', 'French (Canada)', 'Français (Canada)', 7, { requiresLocaleChoice: true }),
  locale('de-DE', 'German (Germany)', 'Deutsch', 8),
  locale('ja-JP', 'Japanese', '日本語', 9, { note: 'Timing expansion and honorific handling.' }),
  locale('ko-KR', 'Korean', '한국어', 10),
  locale('id-ID', 'Indonesian', 'Bahasa Indonesia', 11),
  locale('bn-IN', 'Bengali (India)', 'বাংলা (ভারত)', 12, { requiresLocaleChoice: true }),
  locale('bn-BD', 'Bengali (Bangladesh)', 'বাংলা (বাংলাদেশ)', 12, { requiresLocaleChoice: true }),
  locale('ur-PK', 'Urdu (Pakistan)', 'اردو', 13, {
    direction: 'rtl',
    note: 'RTL review and voice-provider validation required.',
  }),
  locale('ru-RU', 'Russian', 'Русский', 14, {
    note: 'Distribution, sanctions, and provider availability must be reviewed by counsel.',
  }),
  locale('tr-TR', 'Turkish', 'Türkçe', 15, { note: 'Timing-aware translation required.' }),
];

export interface CapabilityRegistry {
  list(): readonly LocaleCapability[];
  get(locale: string): LocaleCapability | undefined;
  /** Locales whose tier for `kind` is at least `minTier` (production ⊃ beta). */
  selectable(kind: CapabilityKind, minTier?: CapabilityTier): readonly LocaleCapability[];
}

const TIER_RANK: Record<CapabilityTier, number> = { production: 2, beta: 1, unavailable: 0 };

export function createRegistry(
  locales: readonly LocaleCapability[] = SEED_LOCALES,
): CapabilityRegistry {
  const byTag = new Map(locales.map((l) => [l.locale, l] as const));
  return {
    list: () =>
      [...locales].sort((a, b) => a.priority - b.priority || a.locale.localeCompare(b.locale)),
    get: (tag) => byTag.get(tag),
    selectable: (kind, minTier = 'beta') =>
      locales
        .filter((l) => TIER_RANK[l.tiers[kind]] >= TIER_RANK[minTier])
        .sort((a, b) => a.priority - b.priority || a.locale.localeCompare(b.locale)),
  };
}

/** Guard that no seed locale is accidentally promoted outside the benchmark process. */
export function assertNoProductionInSeed(
  locales: readonly LocaleCapability[] = SEED_LOCALES,
): void {
  for (const l of locales) {
    for (const kind of CAPABILITY_KINDS) {
      if (l.tiers[kind] === 'production') {
        throw new Error(
          `Seed locale ${l.locale} has ${kind}=production; promotion must go through the benchmark gate`,
        );
      }
    }
  }
}
