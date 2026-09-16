/**
 * Types that `@polycast/contracts` exposes only as Zod schemas. Inferred here rather than
 * duplicated, so the API contract stays the single source of truth.
 */
import type {
  CommentSchema,
  CommentsResponseSchema,
  CreateProjectRequestSchema,
  DownloadLinkResponseSchema,
  JobListResponseSchema,
  RegenerateResponseSchema,
} from '@polycast/contracts';
import type { z } from 'zod';

export type JobListResponse = z.infer<typeof JobListResponseSchema>;
export type RegenerateResponse = z.infer<typeof RegenerateResponseSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type CommentsResponse = z.infer<typeof CommentsResponseSchema>;
export type DownloadLink = z.infer<typeof DownloadLinkResponseSchema>;
