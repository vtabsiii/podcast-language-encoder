import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DomainError } from '@polycast/domain';
import {
  ClaimTaskRequestSchema,
  ErrorEnvelopeSchema,
  IdSchema,
  TaskResultResponseSchema,
  TaskResultSchema,
  WorkerTaskSchema,
} from '@polycast/contracts';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import type { LocalOrchestrator } from '../orchestrator/local.js';
import { claimTask, heartbeatTask, toWorkerTask } from '../orchestrator/tasks.js';

export interface InternalRouteOptions {
  config: AppConfig;
  db: Db;
  orchestrator: LocalOrchestrator;
}

/**
 * Worker protocol (docs/architecture.md §2): workers never touch the database. They claim a
 * task, heartbeat while working, and post a typed result. Authenticated by a shared token;
 * in AWS these routes sit behind the VPC and Step Functions task tokens replace claiming.
 */
export const internalRoutes: FastifyPluginAsyncZod<InternalRouteOptions> = async (app, opts) => {
  const expected = Buffer.from(opts.config.WORKER_TOKEN);
  app.addHook('onRequest', async (req) => {
    const given = req.headers['x-worker-token'];
    const buf = Buffer.from(typeof given === 'string' ? given : '');
    if (buf.length !== expected.length || !timingSafeEqual(buf, expected)) {
      throw new DomainError('UNAUTHENTICATED', 'Worker token required');
    }
  });

  app.post(
    '/tasks/claim',
    {
      schema: {
        tags: ['internal'],
        summary: 'Claim the next runnable stage task',
        body: ClaimTaskRequestSchema,
        response: { 200: WorkerTaskSchema, 204: z.null(), 401: ErrorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const row = await opts.db.withSystem((tx) =>
        claimTask(tx, req.body.workerId, opts.config.TASK_LEASE_SECONDS, req.body.stages),
      );
      if (!row) return reply.status(204).send(null);
      return toWorkerTask(row, opts.config.TASK_LEASE_SECONDS);
    },
  );

  app.post(
    '/tasks/:taskId/heartbeat',
    {
      schema: {
        tags: ['internal'],
        params: z.object({ taskId: IdSchema }),
        body: z.object({ workerId: z.string().min(1) }),
        response: { 200: z.object({ ok: z.boolean() }), 401: ErrorEnvelopeSchema },
      },
    },
    async (req) => {
      const ok = await opts.db.withSystem((tx) =>
        heartbeatTask(tx, req.params.taskId, req.body.workerId, opts.config.TASK_LEASE_SECONDS),
      );
      return { ok };
    },
  );

  app.post(
    '/tasks/:taskId/result',
    {
      schema: {
        tags: ['internal'],
        summary: 'Post a stage result',
        params: z.object({ taskId: IdSchema }),
        body: TaskResultSchema,
        response: { 200: TaskResultResponseSchema, 401: ErrorEnvelopeSchema },
      },
    },
    async (req) => {
      const nextState = await opts.orchestrator.applyResult(req.params.taskId, req.body, req.id);
      return { accepted: nextState !== null, nextState };
    },
  );
};
