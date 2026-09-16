import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LanguageCapabilitiesResponseSchema, ErrorEnvelopeSchema } from '@polycast/contracts';
import { createRegistry, type CapabilityRegistry } from '@polycast/domain';
import type { AppConfig } from '../config.js';

export interface CapabilitiesRouteOptions {
  config: AppConfig;
  registry?: CapabilityRegistry;
}

/**
 * GET /api/v1/capabilities/languages?region=us-east-1
 * The language checklist reads this; it never hard-codes locales.
 */
export const capabilityRoutes: FastifyPluginAsyncZod<CapabilitiesRouteOptions> = async (
  app,
  opts,
) => {
  const registry = opts.registry ?? createRegistry();

  app.get(
    '/capabilities/languages',
    {
      schema: {
        tags: ['capabilities'],
        summary: 'List locales and their capability tiers for a region',
        querystring: z.object({
          region: z.string().default(opts.config.AWS_REGION),
          /** Filter to locales at or above this tier for the given kind. */
          kind: z.enum(['transcription', 'translation', 'speech', 'lipSync']).optional(),
          minTier: z.enum(['production', 'beta']).optional(),
        }),
        response: { 200: LanguageCapabilitiesResponseSchema, 400: ErrorEnvelopeSchema },
      },
    },
    async (req) => {
      const { region, kind, minTier } = req.query;
      const locales = kind ? registry.selectable(kind, minTier ?? 'beta') : registry.list();
      return {
        region,
        priorityScoreVersion: opts.config.PRIORITY_SCORE_VERSION,
        locales: locales.map((l) => ({ ...l, tiers: { ...l.tiers } })),
      };
    },
  );
};
