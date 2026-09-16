import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdSchema, type DomainEvent } from '@polycast/contracts';
import { principalOf, requireAuth } from '../auth/principal.js';
import type { Db } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';

export interface EventRouteOptions {
  db: Db;
  hub: EventHub;
  heartbeatMs?: number;
}

/**
 * Server-Sent Events (FR-052). Tenant-scoped through the hub; `Last-Event-ID` replays missed
 * events from the outbox (UUID v7 ids sort by time). Heartbeat comments keep proxies open.
 */
export const eventRoutes: FastifyPluginAsyncZod<EventRouteOptions> = async (app, opts) => {
  app.get(
    '/events',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['events'],
        summary: 'Stream domain events for the organization (optionally one project)',
        querystring: z.object({ projectId: IdSchema.optional() }),
        headers: z.object({ 'last-event-id': z.string().optional() }),
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const projectId = req.query.projectId ?? null;
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'x-request-id': req.id,
      });
      const write = (event: DomainEvent) => {
        raw.write(`id: ${event.eventId}\nevent: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      raw.write(
        `event: ready\ndata: ${JSON.stringify({ organizationId: p.organizationId, projectId })}\n\n`,
      );

      const lastId = req.headers['last-event-id'];
      if (lastId) {
        const missed = await opts.db.withTenant(
          { organizationId: p.organizationId, userId: p.userId },
          async (tx) => {
            const res = await tx.query<{
              id: string;
              name: DomainEvent['name'];
              occurred_at: Date;
              correlation_id: string;
              subject_type: string;
              subject_id: string;
              payload: Record<string, unknown>;
            }>(
              `SELECT id, name, occurred_at, correlation_id, subject_type, subject_id, payload FROM domain_events
             WHERE organization_id = $1 AND id > $2 ${projectId ? 'AND project_id = $3' : ''} ORDER BY id LIMIT 500`,
              projectId ? [p.organizationId, lastId, projectId] : [p.organizationId, lastId],
            );
            return res.rows;
          },
        );
        for (const m of missed) {
          write({
            eventId: m.id,
            name: m.name,
            occurredAt: m.occurred_at.toISOString(),
            organizationId: p.organizationId,
            correlationId: m.correlation_id,
            schemaVersion: 1,
            subject: { type: m.subject_type, id: m.subject_id },
            payload: m.payload,
          } as DomainEvent);
        }
      }

      const unsubscribe = opts.hub.subscribe({
        organizationId: p.organizationId,
        projectId,
        deliver: write,
      });
      const heartbeat = setInterval(() => raw.write(': ping\n\n'), opts.heartbeatMs ?? 15_000);
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        if (!raw.writableEnded) raw.end();
      };
      req.raw.on('close', close);
      req.raw.on('error', close);
    },
  );
};
