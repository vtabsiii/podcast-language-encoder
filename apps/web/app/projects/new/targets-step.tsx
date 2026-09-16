'use client';

import type { LanguageCapabilitiesResponse } from '@polycast/contracts';
import { Button, StatusBadge, Table, toneForTier } from '@polycast/ui';

export interface TargetChoice {
  locale: string;
  lipSync: boolean;
}

export interface TargetsStepProps {
  locales: LanguageCapabilitiesResponse['locales'];
  sourceLocale: string | null;
  hasVideo: boolean;
  choices: TargetChoice[];
  onChange: (choices: TargetChoice[]) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function TargetsStep({
  locales,
  sourceLocale,
  hasVideo,
  choices,
  onChange,
  onBack,
  onContinue,
}: TargetsStepProps) {
  const selected = new Map(choices.map((c) => [c.locale, c]));
  const candidates = locales.filter((l) => l.locale !== sourceLocale);

  function toggle(locale: string, on: boolean) {
    if (on) {
      // Lip sync is on by default wherever it is possible; the reviewer can still opt out.
      const tier = candidates.find((l) => l.locale === locale)?.tiers.lipSync;
      const possible = hasVideo && tier !== undefined && tier !== 'unavailable';
      onChange([...choices, { locale, lipSync: possible }]);
    } else onChange(choices.filter((c) => c.locale !== locale));
  }
  function setLipSync(locale: string, lipSync: boolean) {
    onChange(choices.map((c) => (c.locale === locale ? { ...c, lipSync } : c)));
  }

  return (
    <div className="card" aria-labelledby="targets-heading">
      <h2 id="targets-heading">Step 3: Choose target languages</h2>
      <p className="muted">
        Tiers come from the capability registry. Beta targets require native-speaker review before
        they can be marked Ready and carry no quality SLA.
        {!hasVideo && ' This source has no video, so lip sync is not available.'}
      </p>
      <Table caption="Target languages" hideCaption>
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">Language</th>
            <th scope="col">Translation</th>
            <th scope="col">Speech</th>
            <th scope="col">Lip sync</th>
            <th scope="col">Enable lip sync</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((l) => {
            const unavailable =
              l.tiers.translation === 'unavailable' || l.tiers.speech === 'unavailable';
            const lipSyncPossible =
              hasVideo && l.tiers.lipSync !== 'unavailable' && l.tiers.lipSync !== undefined;
            const choice = selected.get(l.locale);
            const beta = l.tiers.translation === 'beta' || l.tiers.speech === 'beta';
            const id = `target-${l.locale}`;
            return (
              <tr key={l.locale}>
                <td>
                  <input
                    type="checkbox"
                    id={id}
                    checked={Boolean(choice)}
                    disabled={unavailable}
                    onChange={(e) => toggle(l.locale, e.target.checked)}
                    aria-describedby={beta ? `${id}-beta` : undefined}
                  />
                </td>
                <td>
                  <label htmlFor={id}>
                    {l.displayName}{' '}
                    <span dir={l.direction} lang={l.locale} className="muted">
                      ({l.nativeName})
                    </span>{' '}
                    <code>{l.locale}</code>
                    {l.direction === 'rtl' && <span className="muted small"> · RTL</span>}
                  </label>
                  {beta && (
                    <div id={`${id}-beta`} className="small muted">
                      Beta: requires native review.
                    </div>
                  )}
                </td>
                <td>
                  <StatusBadge tone={toneForTier(l.tiers.translation)}>
                    {l.tiers.translation ?? 'unavailable'}
                  </StatusBadge>
                </td>
                <td>
                  <StatusBadge tone={toneForTier(l.tiers.speech)}>
                    {l.tiers.speech ?? 'unavailable'}
                  </StatusBadge>
                </td>
                <td>
                  <StatusBadge tone={toneForTier(l.tiers.lipSync)}>
                    {l.tiers.lipSync ?? 'unavailable'}
                  </StatusBadge>
                </td>
                <td>
                  <input
                    type="checkbox"
                    id={`${id}-lipsync`}
                    aria-label={`Lip sync for ${l.displayName}`}
                    checked={choice?.lipSync ?? false}
                    disabled={!choice || !lipSyncPossible}
                    onChange={(e) => setLipSync(l.locale, e.target.checked)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <p className="small" role="status" aria-live="polite">
        {choices.length === 0
          ? 'No targets selected.'
          : `${choices.length} target${choices.length === 1 ? '' : 's'} selected.`}
      </p>
      <div className="actions">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onContinue} disabled={choices.length === 0}>
          Continue
        </Button>
      </div>
    </div>
  );
}
