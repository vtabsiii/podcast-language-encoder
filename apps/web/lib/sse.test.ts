import { describe, expect, it } from 'vitest';
import { eventsUrl, parseDomainEvent } from './sse';

const base = {
  eventId: '018f4d1c-0d8e-7c3b-8c8e-1a2b3c4d5e6f',
  occurredAt: '2026-09-16T10:00:00.000Z',
  organizationId: '018f4d1c-0d8e-7c3b-8c8e-1a2b3c4d5e70',
  correlationId: 'corr-1',
  schemaVersion: 1,
  subject: { type: 'targetJob', id: '018f4d1c-0d8e-7c3b-8c8e-1a2b3c4d5e71' },
};

describe('parseDomainEvent', () => {
  it('parses a target.stage.changed event', () => {
    const ev = parseDomainEvent(
      JSON.stringify({
        ...base,
        name: 'target.stage.changed',
        payload: {
          projectId: base.organizationId,
          jobId: base.organizationId,
          targetJobId: base.subject.id,
          locale: 'es-419',
          from: 'TRANSLATING',
          to: 'SYNTHESIZING',
          attempt: 1,
          progress: 0.25,
          message: null,
        },
      }),
    );
    expect(ev?.name).toBe('target.stage.changed');
    if (ev?.name === 'target.stage.changed') expect(ev.payload.to).toBe('SYNTHESIZING');
  });
  it('returns null for garbage', () => {
    expect(parseDomainEvent('not json')).toBeNull();
    expect(parseDomainEvent(JSON.stringify({ hello: 'world' }))).toBeNull();
  });
  it('builds the proxied events url', () => {
    expect(eventsUrl('abc/def')).toBe('/api/v1/events?projectId=abc%2Fdef');
  });
});
