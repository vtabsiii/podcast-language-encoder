import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DomainError } from '@polycast/domain';
import {
  CreateJobRequestSchema,
  ErrorEnvelopeSchema,
  IdSchema,
  JobHistoryResponseSchema,
  JobResponseSchema,
  TargetJobSchema,
} from '@polycast/contracts';
import { principalOf, requirePermission } from '../auth/principal.js';
import type { JobService } from '../services/jobs.js';

export interface JobRouteOptions {
  jobs: JobService;
}

const errors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  402: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
};

export const jobRoutes: FastifyPluginAsyncZod<JobRouteOptions> = async (app, opts) => {
  app.post(
    '/localization-jobs',
    {
      preHandler: requirePermission('job:create'),
      schema: {
        tags: ['jobs'],
        summary: 'Create a localization job (requires Idempotency-Key)',
        headers: z.object({ 'idempotency-key': z.string().min(8).max(200) }),
        body: CreateJobRequestSchema,
        response: { 200: JobResponseSchema, 201: JobResponseSchema, ...errors },
      },
    },
    async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (!key) throw new DomainError('VALIDATION_FAILED', 'Idempotency-Key header is required');
      const { statusCode, body } = await opts.jobs.create(
        principalOf(req),
        key,
        req.body,
        req.id,
        req.ip,
      );
      return reply.status(statusCode).send(body);
    },
  );
  app.get(
    '/localization-jobs/:jobId',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['jobs'],
        params: z.object({ jobId: IdSchema }),
        response: { 200: JobHistoryResponseSchema, ...errors },
      },
    },
    async (req) => opts.jobs.get(principalOf(req), req.params.jobId),
  );
  app.post(
    '/localization-jobs/:jobId/cancel',
    {
      preHandler: requirePermission('job:cancel'),
      schema: {
        tags: ['jobs'],
        params: z.object({ jobId: IdSchema }),
        response: { 200: JobResponseSchema, ...errors },
      },
    },
    async (req) => opts.jobs.cancel(principalOf(req), req.params.jobId, req.id, req.ip),
  );
  app.get(
    '/target-jobs/:targetJobId',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['jobs'],
        params: z.object({ targetJobId: IdSchema }),
        response: { 200: z.object({ target: TargetJobSchema }), ...errors },
      },
    },
    async (req) => opts.jobs.getTarget(principalOf(req), req.params.targetJobId),
  );
  app.post(
    '/target-jobs/:targetJobId/retry',
    {
      preHandler: requirePermission('job:create'),
      schema: {
        tags: ['jobs'],
        params: z.object({ targetJobId: IdSchema }),
        response: { 200: z.object({ target: TargetJobSchema }), ...errors },
      },
    },
    async (req) => opts.jobs.retryTarget(principalOf(req), req.params.targetJobId, req.id, req.ip),
  );
};
