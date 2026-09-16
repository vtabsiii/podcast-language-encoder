import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { loadConfig, type AppConfig } from './config.js';
import { registerErrorHandler } from './plugins/errors.js';
import { healthRoutes } from './routes/health.js';
import { capabilityRoutes } from './routes/capabilities.js';

export interface BuildOptions {
  config?: AppConfig;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();

  const app = Fastify({
    logger: opts.logger ?? config.NODE_ENV !== 'test',
    // Correlation id: honour an inbound X-Request-Id, else mint one. Echoed on every error.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    bodyLimit: 1024 * 1024, // 1 MiB. Media never travels through the API; uploads go direct to S3.
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Polycast Studio API',
        version: '1.0.0',
        description:
          'Control-plane API. All routes are tenant-scoped by the authenticated principal; ' +
          'organization ids in request bodies are never trusted.',
      },
      servers: [{ url: '/api/v1' }],
      tags: [{ name: 'ops' }, { name: 'capabilities' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-request-id', _req.id);
  });

  registerErrorHandler(app);

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      await v1.register(capabilityRoutes, { config });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
