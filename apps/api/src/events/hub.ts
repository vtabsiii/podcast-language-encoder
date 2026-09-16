import { EventEmitter } from 'node:events';
import type pg from 'pg';
import type { DomainEvent } from '@polycast/contracts';
import { EVENT_CHANNEL } from './outbox.js';

export interface Subscription {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly deliver: (event: DomainEvent) => void;
}

/**
 * Fan-out hub for SSE (FR-052). Listens on the Postgres channel so every API instance sees
 * every committed event; subscribers are filtered by organization (never cross-tenant) and
 * optionally by project.
 */
export class EventHub {
  private readonly emitter = new EventEmitter();
  private client: pg.PoolClient | null = null;
  private closed = false;

  constructor(private readonly pool: pg.Pool) {
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    const client = await this.pool.connect();
    this.client = client;
    client.on('notification', (msg) => {
      if (msg.channel !== EVENT_CHANNEL || !msg.payload) return;
      try {
        this.emitter.emit('event', JSON.parse(msg.payload) as DomainEvent);
      } catch {
        // malformed payloads are dropped; the outbox row remains for replay
      }
    });
    client.on('error', () => {
      if (!this.closed) void this.reconnect();
    });
    await client.query(`LISTEN ${EVENT_CHANNEL}`);
  }

  private async reconnect(): Promise<void> {
    this.client?.release(true);
    this.client = null;
    await new Promise((r) => setTimeout(r, 500));
    if (!this.closed) await this.start().catch(() => this.reconnect());
  }

  /** In-process publish (used when the hub is not connected, e.g. unit tests). */
  publishLocal(event: DomainEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(sub: Subscription): () => void {
    const handler = (event: DomainEvent) => {
      if (event.organizationId !== sub.organizationId) return;
      if (sub.projectId) {
        const pid = (event.payload as { projectId?: string }).projectId;
        if (pid !== sub.projectId) return;
      }
      sub.deliver(event);
    };
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.client) {
      await this.client.query(`UNLISTEN ${EVENT_CHANNEL}`).catch(() => undefined);
      this.client.release();
      this.client = null;
    }
    this.emitter.removeAllListeners();
  }
}
