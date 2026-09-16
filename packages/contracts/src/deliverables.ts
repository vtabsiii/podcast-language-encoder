import { z } from 'zod';
import { IdSchema, IsoTimestampSchema, Sha256Schema } from './common.js';
import { TargetJobSchema } from './jobs.js';

export const DELIVERABLE_KINDS = [
  'media',
  'captions-srt',
  'captions-vtt',
  'transcript-json',
  'qc-report',
  'provenance-manifest',
  'checksums',
] as const;
export const DeliverableKindSchema = z.enum(DELIVERABLE_KINDS);

export const DeliverableSchema = z.object({
  id: IdSchema,
  kind: DeliverableKindSchema,
  fileName: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  packageVersion: z.number().int().positive(),
  createdAt: IsoTimestampSchema,
});

export const DeliverablesResponseSchema = z.object({
  target: TargetJobSchema,
  packageVersion: z.number().int().nonnegative(),
  deliverables: z.array(DeliverableSchema),
});

export const DownloadLinkResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: IsoTimestampSchema,
  fileName: z.string(),
  sha256: Sha256Schema,
});

export type Deliverable = z.infer<typeof DeliverableSchema>;
export type DeliverablesResponse = z.infer<typeof DeliverablesResponseSchema>;
export type DownloadLinkResponse = z.infer<typeof DownloadLinkResponseSchema>;
