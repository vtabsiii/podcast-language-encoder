import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/healthz',
    {
      schema: {
        tags: ['ops'],
        summary: 'Liveness probe',
        response: { 200: z.object({ status: z.literal('ok'), version: z.string() }) },
      },
    },
    async () => ({ status: 'ok' as const, version: process.env['APP_VERSION'] ?? 'dev' }),
  );
};
