import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DeliverablesResponseSchema,
  DownloadLinkResponseSchema,
  ErrorEnvelopeSchema,
  IdSchema,
  ProvenanceManifestSchema,
} from '@polycast/contracts';
import { NotFoundError } from '@polycast/domain';
import { principalOf, requirePermission } from '../auth/principal.js';
import type { DeliverableService } from '../services/deliverables.js';

export interface DeliverableRouteOptions {
  deliverables: DeliverableService;
}

const errors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
};

export const deliverableRoutes: FastifyPluginAsyncZod<DeliverableRouteOptions> = async (
  app,
  opts,
) => {
  app.get(
    '/target-jobs/:targetJobId/deliverables',
    {
      preHandler: requirePermission('deliverable:download'),
      schema: {
        tags: ['deliverables'],
        params: z.object({ targetJobId: IdSchema }),
        response: { 200: DeliverablesResponseSchema, ...errors },
      },
    },
    async (req) => opts.deliverables.list(principalOf(req), req.params.targetJobId),
  );
  app.get(
    '/target-jobs/:targetJobId/deliverables/manifest',
    {
      preHandler: requirePermission('deliverable:download'),
      schema: {
        tags: ['deliverables'],
        params: z.object({ targetJobId: IdSchema }),
        response: { 200: z.object({ manifest: ProvenanceManifestSchema }), ...errors },
      },
    },
    async (req) => {
      const manifest = await opts.deliverables.manifest(principalOf(req), req.params.targetJobId);
      if (!manifest) throw new NotFoundError('ProvenanceManifest', req.params.targetJobId);
      return { manifest: ProvenanceManifestSchema.parse(manifest) };
    },
  );
  app.get(
    '/target-jobs/:targetJobId/deliverables/:deliverableId/download',
    {
      preHandler: requirePermission('deliverable:download'),
      schema: {
        tags: ['deliverables'],
        summary: 'Mint a short-lived download link',
        params: z.object({ targetJobId: IdSchema, deliverableId: IdSchema }),
        response: { 200: DownloadLinkResponseSchema, ...errors },
      },
    },
    async (req) =>
      opts.deliverables.downloadLink(
        principalOf(req),
        req.params.targetJobId,
        req.params.deliverableId,
        req.id,
        req.ip,
      ),
  );
};
