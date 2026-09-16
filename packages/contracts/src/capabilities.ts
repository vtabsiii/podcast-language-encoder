import { z } from 'zod';
import { CAPABILITY_KINDS, CAPABILITY_TIERS } from '@polycast/domain';

export const CapabilityTierSchema = z.enum(CAPABILITY_TIERS);
export const CapabilityKindSchema = z.enum(CAPABILITY_KINDS);

export const LocaleCapabilitySchema = z.object({
  locale: z.string().regex(/^[a-z]{2}-[A-Z0-9]{2,3}$/),
  language: z.string().length(2),
  displayName: z.string(),
  nativeName: z.string(),
  direction: z.enum(['ltr', 'rtl']),
  requiresLocaleChoice: z.boolean(),
  priority: z.number().int().positive(),
  tiers: z.record(CapabilityKindSchema, CapabilityTierSchema),
  note: z.string().optional(),
});

export const LanguageCapabilitiesResponseSchema = z.object({
  region: z.string(),
  /** Version of the market priority score used to rank these locales. */
  priorityScoreVersion: z.string(),
  locales: z.array(LocaleCapabilitySchema),
});
export type LanguageCapabilitiesResponse = z.infer<typeof LanguageCapabilitiesResponseSchema>;
