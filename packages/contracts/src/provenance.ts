import { z } from 'zod';
import { CapabilityTierSchema } from './capabilities.js';
import { IdSchema, IsoTimestampSchema, LocaleTagSchema, Sha256Schema } from './common.js';

/**
 * Provenance manifest embedded in every deliverable set (FR-063, BR-08). Customers cannot
 * opt out of the manifest, only of on-screen disclosure. Shared with the Python packager
 * through JSON Schema.
 */
export const ProvenanceModelSchema = z.object({
  capability: z.enum(['transcription', 'translation', 'speech', 'lipSync', 'encode', 'quality']),
  adapterId: z.string(),
  version: z.string(),
  tier: CapabilityTierSchema,
  dataPolicy: z.literal('no-training'),
});

export const ProvenanceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generator: z.string(),
  generatedAt: IsoTimestampSchema,
  jobId: IdSchema,
  targetJobId: IdSchema,
  projectId: IdSchema,
  sourceLocale: LocaleTagSchema,
  targetLocale: LocaleTagSchema,
  sourceSha256: Sha256Schema,
  syntheticVoice: z.boolean(),
  lipSyncApplied: z.boolean(),
  /** True when any adapter in `models` is a mock; deliverables are then fixtures, not localizations. */
  mock: z.boolean(),
  models: z.array(ProvenanceModelSchema),
  segmentCount: z.number().int().nonnegative(),
  translationVersionIds: z.array(IdSchema),
  files: z.array(
    z.object({ fileName: z.string(), sha256: Sha256Schema, byteSize: z.number().int() }),
  ),
  disclosure: z.string(),
});
export type ProvenanceManifest = z.infer<typeof ProvenanceManifestSchema>;

/** Machine-readable QC report included in deliverables (FR-041). */
export const QcReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoTimestampSchema,
  targetJobId: IdSchema,
  locale: LocaleTagSchema,
  passed: z.boolean(),
  checks: z.array(
    z.object({
      metric: z.string(),
      threshold: z.number().nullable(),
      value: z.number().nullable(),
      passed: z.boolean(),
      provider: z.string(),
    }),
  ),
  issues: z.array(
    z.object({
      id: IdSchema,
      segmentId: IdSchema.nullable(),
      metric: z.string(),
      severity: z.enum(['info', 'warning', 'critical']),
      recommendation: z.string(),
      resolution: z.enum(['open', 'accepted', 'regenerated', 'dismissed']),
    }),
  ),
  summary: z.string(),
});
export type QcReport = z.infer<typeof QcReportSchema>;
