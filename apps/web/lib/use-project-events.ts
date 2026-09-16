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
 * the screen never goes stale (NFR: processing view within 2 s of a transition). `onPoll` also
 * runs once each time the stream opens, closing the gap between the server-rendered state and
 * the first live event.
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
    // Events published between the server render and the moment the stream is open are not
    // replayed (Last-Event-ID only covers reconnects), so every (re)connect reconciles once.
    let reconciled = false;
    const live = () => {
      setConnection('live');
      stopPolling();
      if (!reconciled) {
        reconciled = true;
        handlers.current.onPoll?.();
      }
    };
    source.addEventListener('ready', live);
    source.onopen = live;
    source.onerror = () => {
      reconciled = false;
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
