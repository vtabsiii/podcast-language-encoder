import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CompleteUploadRequestSchema,
  ErrorEnvelopeSchema,
  IdSchema,
  InitUploadRequestSchema,
  InitUploadResponseSchema,
  SignPartsRequestSchema,
  SignPartsResponseSchema,
  UploadStatusSchema,
} from '@polycast/contracts';
import { principalOf, requirePermission } from '../auth/principal.js';
import type { UploadService } from '../services/uploads.js';

export interface UploadRouteOptions {
  uploads: UploadService;
}

const errors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
};
const params = z.object({ uploadId: IdSchema });

export const uploadRoutes: FastifyPluginAsyncZod<UploadRouteOptions> = async (app, opts) => {
  app.post(
    '/uploads',
    {
      preHandler: requirePermission('project:configure'),
      schema: {
        tags: ['uploads'],
        summary: 'Start or resume a multipart upload',
        body: InitUploadRequestSchema,
        response: { 200: InitUploadResponseSchema, ...errors },
      },
    },
    async (req) => opts.uploads.init(principalOf(req), req.body, req.id, req.ip),
  );
  app.get(
    '/uploads/:uploadId',
    {
      preHandler: requirePermission('project:read'),
      schema: { tags: ['uploads'], params, response: { 200: UploadStatusSchema, ...errors } },
    },
    async (req) => opts.uploads.status(principalOf(req), req.params.uploadId),
  );
  app.post(
    '/uploads/:uploadId/parts',
    {
      preHandler: requirePermission('project:configure'),
      schema: {
        tags: ['uploads'],
        params,
        body: SignPartsRequestSchema,
        response: { 200: SignPartsResponseSchema, ...errors },
      },
    },
    async (req) =>
      opts.uploads.signParts(principalOf(req), req.params.uploadId, req.body.partNumbers),
  );
  app.post(
    '/uploads/:uploadId/complete',
    {
      preHandler: requirePermission('project:configure'),
      schema: {
        tags: ['uploads'],
        params,
        body: CompleteUploadRequestSchema,
        response: { 200: UploadStatusSchema, ...errors },
      },
    },
    async (req) =>
      opts.uploads.complete(principalOf(req), req.params.uploadId, req.body.parts, req.id, req.ip),
  );
  app.post(
    '/uploads/:uploadId/abort',
    {
      preHandler: requirePermission('project:configure'),
      schema: { tags: ['uploads'], params, response: { 200: UploadStatusSchema, ...errors } },
    },
    async (req) => opts.uploads.abort(principalOf(req), req.params.uploadId, req.id, req.ip),
  );
};
