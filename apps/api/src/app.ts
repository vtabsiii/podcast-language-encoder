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
import { authPlugin } from './auth/principal.js';
import { loadConfig, type AppConfig } from './config.js';
import { createDb, type Db } from './db/pool.js';
import { EventHub } from './events/hub.js';
import { loggerOptions } from './logging.js';
import { LocalOrchestrator } from './orchestrator/local.js';
import { registerErrorHandler } from './plugins/errors.js';
import { authRoutes } from './routes/auth.js';
import { capabilityRoutes } from './routes/capabilities.js';
import { deliverableRoutes } from './routes/deliverables.js';
import { eventRoutes } from './routes/events.js';
import { healthRoutes } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { jobRoutes } from './routes/jobs.js';
import { localStorageRoutes } from './routes/local-storage.js';
import { projectRoutes } from './routes/projects.js';
import { reviewRoutes } from './routes/review.js';
import { uploadRoutes } from './routes/uploads.js';
import { DeliverableService } from './services/deliverables.js';
import { JobService } from './services/jobs.js';
import { ProjectService } from './services/projects.js';
import { ReviewService } from './services/review.js';
import { UploadService } from './services/uploads.js';
import {
  bucketsFromConfig,
  createStorage,
  LocalFsStorage,
  type StorageDriver,
} from './storage/index.js';

export interface BuildOptions {
  config?: AppConfig;
  logger?: boolean;
  /** Provide an existing Db (tests share one pool). */
  db?: Db;
  /** Do not connect the LISTEN client (unit tests without a database). */
  withoutDatabase?: boolean;
}

export interface AppContext {
  config: AppConfig;
  db: Db | null;
  storage: StorageDriver;
  hub: EventHub | null;
  orchestrator: LocalOrchestrator | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : opts.logger === true || config.NODE_ENV !== 'test'
          ? loggerOptions(config.NODE_ENV === 'production' ? 'info' : 'debug')
          : false,
    // Correlation id: honour an inbound X-Request-Id, else mint one. Echoed on every response.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    bodyLimit: 1024 * 1024, // 1 MiB. Media never travels through the API; uploads go direct to storage.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    exposedHeaders: ['ETag', 'x-request-id'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Organization-Id',
      'Idempotency-Key',
      'Last-Event-ID',
      'X-Request-Id',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Polycast Studio API',
        version: '1.0.0',
        description:
          'Control-plane API. All routes are tenant-scoped by the authenticated principal; organization ids in request bodies are never trusted.',
      },
      servers: [{ url: '/api/v1' }],
      tags: [
        { name: 'ops' },
        { name: 'auth' },
        { name: 'capabilities' },
        { name: 'projects' },
        { name: 'uploads' },
        { name: 'jobs' },
        { name: 'review' },
        { name: 'deliverables' },
        { name: 'events' },
        { name: 'internal' },
      ],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  registerErrorHandler(app);

  const storage = createStorage(config);
  const buckets = bucketsFromConfig(config);
  const db = opts.withoutDatabase ? null : (opts.db ?? createDb(config));
  const hub = db ? new EventHub(db.app) : null;
  const orchestrator = db ? new LocalOrchestrator({ config, db, storage, buckets }) : null;
  app.decorate('ctx', { config, db, storage, hub, orchestrator });

  await app.register(healthRoutes);
  if (storage instanceof LocalFsStorage) {
    await app.register(localStorageRoutes, { storage, maxBodyBytes: 64 * 1024 * 1024 });
  }

  if (db && hub && orchestrator) {
    await app.register(authPlugin, { config, db });
    const projects = new ProjectService(db);
    const jobs = new JobService(db, orchestrator);
    const uploads = new UploadService(db, storage, buckets, orchestrator);
    const review = new ReviewService(db, storage, orchestrator);
    const deliverables = new DeliverableService(db, storage);

    await app.register(
      async (v1) => {
        await v1.register(capabilityRoutes, { config });
        await v1.register(authRoutes, { config, db });
        await v1.register(projectRoutes, { projects, jobs });
        await v1.register(uploadRoutes, { uploads });
        await v1.register(jobRoutes, { jobs });
        await v1.register(reviewRoutes, { review });
        await v1.register(deliverableRoutes, { deliverables });
        await v1.register(eventRoutes, { db, hub });
      },
      { prefix: '/api/v1' },
    );
    await app.register(internalRoutes, { config, db, orchestrator, prefix: '/internal/v1' });

    app.addHook('onReady', async () => {
      await hub.start();
    });
    app.addHook('onClose', async () => {
      await hub.close();
      if (!opts.db) await db.close();
    });
  } else {
    await app.register(
      async (v1) => {
        await v1.register(capabilityRoutes, { config });
      },
      { prefix: '/api/v1' },
    );
  }

  return app;
}
