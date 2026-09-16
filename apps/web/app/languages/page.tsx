import { StatusBadge } from '@polycast/ui';
import { apiGet } from '@/lib/api';

interface LocaleRow {
  locale: string;
  displayName: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
  priority: number;
  tiers: Record<string, 'production' | 'beta' | 'unavailable'>;
  note?: string;
}
interface Response {
  region: string;
  priorityScoreVersion: string;
  locales: LocaleRow[];
}

const TONE = { production: 'ok', beta: 'warn', unavailable: 'queued' } as const;

export const dynamic = 'force-dynamic';

export default async function LanguagesPage() {
  let data: Response | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<Response>('/api/v1/capabilities/languages');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Unknown error';
  }

  return (
    <section aria-labelledby="languages-heading">
      <h1 id="languages-heading">Language capabilities</h1>
      <p className="muted">
        A language is selectable only at the tier recorded in the capability registry. Beta
        languages require native-speaker review before a target can be marked Ready. No language is
        Production until it passes the end-to-end benchmark.
      </p>
      {error && (
        <div className="card" role="alert">
          <strong>Could not load the capability registry.</strong>
          <p className="muted">{error}</p>
          <p className="muted">Start the API (`pnpm --filter @polycast/api dev`) and reload.</p>
        </div>
      )}
      {data && (
        <div className="card">
          <p className="muted">
            Region {data.region} · priority score {data.priorityScoreVersion}
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Priority</th>
                <th scope="col">Locale</th>
                <th scope="col">Name</th>
                <th scope="col">Speech</th>
                <th scope="col">Lip sync</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {data.locales.map((l) => (
                <tr key={l.locale}>
                  <td>{l.priority}</td>
                  <td>
                    <code>{l.locale}</code>
                  </td>
                  <td>
                    {l.displayName}{' '}
                    <span dir={l.direction} lang={l.locale} className="muted">
                      ({l.nativeName})
                    </span>
                  </td>
                  <td>
                    <StatusBadge tone={TONE[l.tiers.speech ?? 'unavailable']}>
                      {l.tiers.speech}
                    </StatusBadge>
                  </td>
                  <td>
                    <StatusBadge tone={TONE[l.tiers.lipSync ?? 'unavailable']}>
                      {l.tiers.lipSync}
                    </StatusBadge>
                  </td>
                  <td className="muted">{l.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
