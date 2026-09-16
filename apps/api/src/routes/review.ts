import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApproveRequestSchema,
  ApproveResponseSchema,
  CommentSchema,
  CommentsResponseSchema,
  CreateCommentRequestSchema,
  EditTranslationRequestSchema,
  ErrorEnvelopeSchema,
  IdSchema,
  QcIssueSchema,
  RegenerateRequestSchema,
  RegenerateResponseSchema,
  ReviewResponseSchema,
  TranslationVersionSchema,
} from '@polycast/contracts';
import { principalOf, requirePermission } from '../auth/principal.js';
import type { ReviewService } from '../services/review.js';

export interface ReviewRouteOptions {
  review: ReviewService;
}

const errors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
};
const target = z.object({ targetJobId: IdSchema });
const targetSegment = z.object({ targetJobId: IdSchema, segmentId: IdSchema });

export const reviewRoutes: FastifyPluginAsyncZod<ReviewRouteOptions> = async (app, opts) => {
  app.get(
    '/target-jobs/:targetJobId/review',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['review'],
        summary: 'Review studio payload',
        params: target,
        response: { 200: ReviewResponseSchema, ...errors },
      },
    },
    async (req) => opts.review.review(principalOf(req), req.params.targetJobId, req.id, req.ip),
  );
  app.post(
    '/target-jobs/:targetJobId/segments/:segmentId/regenerate',
    {
      preHandler: requirePermission('segment:regenerate'),
      schema: {
        tags: ['review'],
        params: targetSegment,
        body: RegenerateRequestSchema,
        response: { 200: RegenerateResponseSchema, ...errors },
      },
    },
    async (req) =>
      opts.review.regenerate(
        principalOf(req),
        req.params.targetJobId,
        req.params.segmentId,
        req.body.stage,
        req.body.hint ?? null,
        req.id,
        req.ip,
      ),
  );
  app.put(
    '/target-jobs/:targetJobId/segments/:segmentId/translation',
    {
      preHandler: requirePermission('transcript:edit'),
      schema: {
        tags: ['review'],
        params: targetSegment,
        body: EditTranslationRequestSchema,
        response: { 200: z.object({ translation: TranslationVersionSchema }), ...errors },
      },
    },
    async (req) =>
      opts.review.editTranslation(
        principalOf(req),
        req.params.targetJobId,
        req.params.segmentId,
        req.body.adaptedText,
        req.id,
        req.ip,
      ),
  );
  app.post(
    '/target-jobs/:targetJobId/issues/:issueId/resolve',
    {
      preHandler: requirePermission('review:approve'),
      schema: {
        tags: ['review'],
        params: z.object({ targetJobId: IdSchema, issueId: IdSchema }),
        body: z.object({ resolution: z.enum(['accepted', 'dismissed']) }),
        response: { 200: z.object({ issue: QcIssueSchema }), ...errors },
      },
    },
    async (req) =>
      opts.review.resolveIssue(
        principalOf(req),
        req.params.targetJobId,
        req.params.issueId,
        req.body.resolution,
        req.id,
        req.ip,
      ),
  );
  app.post(
    '/target-jobs/:targetJobId/approve',
    {
      preHandler: requirePermission('review:approve'),
      schema: {
        tags: ['review'],
        params: target,
        body: ApproveRequestSchema,
        response: { 200: ApproveResponseSchema, ...errors },
      },
    },
    async (req) =>
      opts.review.approve(
        principalOf(req),
        req.params.targetJobId,
        req.body.segmentIds,
        req.id,
        req.ip,
      ),
  );
  app.get(
    '/target-jobs/:targetJobId/comments',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['review'],
        params: target,
        response: { 200: CommentsResponseSchema, ...errors },
      },
    },
    async (req) => opts.review.comments(principalOf(req), req.params.targetJobId),
  );
  app.post(
    '/target-jobs/:targetJobId/comments',
    {
      preHandler: requirePermission('review:comment'),
      schema: {
        tags: ['review'],
        params: target,
        body: CreateCommentRequestSchema,
        response: { 201: z.object({ comment: CommentSchema }), ...errors },
      },
    },
    async (req, reply) => {
      const res = await opts.review.addComment(
        principalOf(req),
        req.params.targetJobId,
        req.body.body,
        req.body.segmentId ?? null,
        req.id,
        req.ip,
      );
      return reply.status(201).send(res);
    },
  );
};
