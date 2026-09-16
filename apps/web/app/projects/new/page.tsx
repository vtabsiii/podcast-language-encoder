import { Suspense } from 'react';
import type { LanguageCapabilitiesResponse } from '@polycast/contracts';
import { apiGet } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { NewLocalizationWizard } from './wizard';

export const dynamic = 'force-dynamic';

export default async function NewLocalizationPage() {
  let capabilities: LanguageCapabilitiesResponse | null = null;
  let error: string | null = null;
  try {
    capabilities = await apiGet<LanguageCapabilitiesResponse>('/api/v1/capabilities/languages');
  } catch (e) {
    error = describeError(e);
  }
  return (
    <section aria-labelledby="wizard-heading">
      <h1 id="wizard-heading">New localization</h1>
      {error || !capabilities ? (
        <div className="card" role="alert">
          <strong>Could not load the language registry.</strong>
          <p className="muted">{error}</p>
        </div>
      ) : (
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <NewLocalizationWizard capabilities={capabilities} />
        </Suspense>
      )}
    </section>
  );
}
