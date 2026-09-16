'use client';

import { useEffect, useRef, useState } from 'react';
import type { DomainEvent } from '@polycast/contracts';
import { DOMAIN_EVENT_NAMES, eventsUrl, parseDomainEvent } from './sse';

export type EventConnection = 'connecting' | 'live' | 'polling';

export interface UseProjectEventsOptions {
  /** Called for every validated event. */
  onEvent?: (event: DomainEvent) => void;
  /** Called every `pollMs` while the stream is down (and once when it goes down). */
  onPoll?: () => void;
  pollMs?: number;
  /** Keep at most this many events for the log. */
  keep?: number;
  enabled?: boolean;
}

/**
 * Subscribes to `GET /api/v1/events?projectId=…` through the proxy. The browser's EventSource
 * reconnects on its own (sending Last-Event-ID); while it is disconnected we poll instead so
 * the screen never goes stale (NFR: processing view within 2 s of a transition).
 */
export function useProjectEvents(projectId: string, opts: UseProjectEventsOptions = {}) {
  const { pollMs = 5000, keep = 200, enabled = true } = opts;
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [connection, setConnection] = useState<EventConnection>('connecting');
  const handlers = useRef(opts);
  handlers.current = opts;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (poll) return;
      handlers.current.onPoll?.();
      poll = setInterval(() => handlers.current.onPoll?.(), pollMs);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    const source = new EventSource(eventsUrl(projectId));
    const onMessage = (e: MessageEvent<string>) => {
      const event = parseDomainEvent(e.data);
      if (!event) return;
      setEvents((prev) => [event, ...prev].slice(0, keep));
      handlers.current.onEvent?.(event);
    };
    for (const name of DOMAIN_EVENT_NAMES) source.addEventListener(name, onMessage);
    source.addEventListener('ready', () => {
      setConnection('live');
      stopPolling();
    });
    source.onopen = () => {
      setConnection('live');
      stopPolling();
    };
    source.onerror = () => {
      setConnection('polling');
      startPolling();
    };
    return () => {
      source.close();
      stopPolling();
    };
  }, [projectId, pollMs, keep, enabled]);

  return { events, connection };
}
