import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './common.js';
import { AssetStatusSchema } from './projects.js';

/** Resumable multipart upload (FR-001). Media bytes never pass through the API. */
export const SUPPORTED_SOURCE_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
] as const;

export const InitUploadRequestSchema = z.object({
  projectId: IdSchema,
  fileName: z.string().min(1).max(255),
  contentType: z.enum(SUPPORTED_SOURCE_TYPES),
  byteSize: z.number().int().positive(),
});

export const InitUploadResponseSchema = z.object({
  uploadId: IdSchema,
  assetId: IdSchema,
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
  /** Already-uploaded parts when the client resumes an existing upload for the same asset. */
  uploadedParts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string() })),
});

export const SignPartsRequestSchema = z.object({
  partNumbers: z.array(z.number().int().positive()).min(1).max(100),
});

export const SignPartsResponseSchema = z.object({
  parts: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      url: z.string().url(),
      expiresAt: IsoTimestampSchema,
    }),
  ),
});

export const CompleteUploadRequestSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
    .min(1),
});

export const UploadStatusSchema = z.object({
  uploadId: IdSchema,
  assetId: IdSchema,
  projectId: IdSchema,
  status: z.enum(['active', 'completed', 'aborted']),
  assetStatus: AssetStatusSchema,
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
  byteSize: z.number().int().positive(),
  uploadedParts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string() })),
});

export const CompleteUploadResponseSchema = UploadStatusSchema;

export type InitUploadRequest = z.infer<typeof InitUploadRequestSchema>;
export type InitUploadResponse = z.infer<typeof InitUploadResponseSchema>;
export type SignPartsResponse = z.infer<typeof SignPartsResponseSchema>;
export type UploadStatus = z.infer<typeof UploadStatusSchema>;
