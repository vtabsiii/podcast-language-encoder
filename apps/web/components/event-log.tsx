import type { DomainEvent } from '@polycast/contracts';
import { formatClock, humanizeState } from '@/lib/format';
import { isAssetEvent, isJobEvent, isStageChanged } from '@/lib/sse';
import type { EventConnection } from '@/lib/use-project-events';

function describe(e: DomainEvent): string {
  if (isStageChanged(e)) {
    const p = e.payload;
    return `${p.locale}: ${p.from ? humanizeState(p.from) : 'start'} → ${humanizeState(p.to)}${
      p.attempt > 1 ? ` (attempt ${p.attempt})` : ''
    }${p.message ? ` — ${p.message}` : ''}`;
  }
  if (isAssetEvent(e)) {
    return `${e.name}: ${humanizeState(e.payload.status)}${e.payload.reason ? ` — ${e.payload.reason.message}` : ''}`;
  }
  if (isJobEvent(e)) return `${e.name}${e.payload.locale ? ` (${e.payload.locale})` : ''}`;
  return e.name;
}

export function EventLog({
  events,
  connection,
}: {
  events: DomainEvent[];
  connection: EventConnection;
}) {
  const status =
    connection === 'live'
      ? 'Live updates connected.'
      : connection === 'polling'
        ? 'Live stream unavailable; refreshing every 5 seconds.'
        : 'Connecting to live updates…';
  return (
    <section aria-labelledby="event-log-heading">
      <h2 id="event-log-heading">Event log</h2>
      <p className="muted small" role="status">
        {status}
      </p>
      {events.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol
          className="event-log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Recent events"
        >
          {events.map((e) => (
            <li key={e.eventId}>
              <time dateTime={e.occurredAt} className="mono">
                {formatClock(e.occurredAt)}
              </time>
              <span>{describe(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
