import { z } from 'zod';
import { ERROR_CODES } from '@polycast/domain';

/** Standard error envelope returned by every API route (docs/product-spec.md §12). */
export const FieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const ErrorEnvelopeSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  correlationId: z.string(),
  retryable: z.boolean(),
  fieldErrors: z.array(FieldErrorSchema).default([]),
  details: z.record(z.unknown()).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
