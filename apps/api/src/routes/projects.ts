import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ConfirmLocaleRequestSchema,
  CreateProjectRequestSchema,
  ErrorEnvelopeSchema,
  EstimateRequestSchema,
  EstimateResponseSchema,
  IdSchema,
  JobListResponseSchema,
  ProjectDetailResponseSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  SegmentsResponseSchema,
} from '@polycast/contracts';
import { principalOf, requirePermission } from '../auth/principal.js';
import type { JobService } from '../services/jobs.js';
import type { ProjectService } from '../services/projects.js';

export interface ProjectRouteOptions {
  projects: ProjectService;
  jobs: JobService;
}

const errors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
};

export const projectRoutes: FastifyPluginAsyncZod<ProjectRouteOptions> = async (app, opts) => {
  app.get(
    '/projects',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['projects'],
        summary: 'Dashboard listing',
        response: { 200: ProjectListResponseSchema, ...errors },
      },
    },
    async (req) => opts.projects.list(principalOf(req)),
  );

  app.post(
    '/projects',
    {
      preHandler: requirePermission('project:create'),
      schema: {
        tags: ['projects'],
        summary: 'Create a project',
        body: CreateProjectRequestSchema,
        response: { 201: z.object({ project: ProjectSchema }), ...errors },
      },
    },
    async (req, reply) => {
      const project = await opts.projects.create(principalOf(req), req.body, req.id, req.ip);
      return reply.status(201).send({ project });
    },
  );

  app.get(
    '/projects/:projectId',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['projects'],
        params: z.object({ projectId: IdSchema }),
        response: { 200: ProjectDetailResponseSchema, ...errors },
      },
    },
    async (req) => opts.projects.detail(principalOf(req), req.params.projectId),
  );

  app.post(
    '/projects/:projectId/confirm-locale',
    {
      preHandler: requirePermission('project:configure'),
      schema: {
        tags: ['projects'],
        params: z.object({ projectId: IdSchema }),
        body: ConfirmLocaleRequestSchema,
        response: { 200: ProjectDetailResponseSchema, ...errors },
      },
    },
    async (req) =>
      opts.projects.confirmLocale(
        principalOf(req),
        req.params.projectId,
        req.body.sourceLocale,
        req.id,
        req.ip,
      ),
  );

  app.get(
    '/projects/:projectId/segments',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['projects'],
        params: z.object({ projectId: IdSchema }),
        response: { 200: SegmentsResponseSchema, ...errors },
      },
    },
    async (req) => opts.projects.segments(principalOf(req), req.params.projectId, req.id, req.ip),
  );

  app.post(
    '/projects/:projectId/estimate',
    {
      preHandler: requirePermission('project:configure'),
      schema: {
        tags: ['jobs'],
        summary: 'Cost estimate and budget check',
        params: z.object({ projectId: IdSchema }),
        body: EstimateRequestSchema,
        response: { 200: EstimateResponseSchema, ...errors },
      },
    },
    async (req) => opts.jobs.estimate(principalOf(req), req.params.projectId, req.body),
  );

  app.get(
    '/projects/:projectId/jobs',
    {
      preHandler: requirePermission('project:read'),
      schema: {
        tags: ['jobs'],
        params: z.object({ projectId: IdSchema }),
        response: { 200: JobListResponseSchema, ...errors },
      },
    },
    async (req) => opts.jobs.listForProject(principalOf(req), req.params.projectId),
  );
};
