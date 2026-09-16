'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type {
  CreateJobRequest,
  EstimateResponse,
  JobResponse,
  LanguageCapabilitiesResponse,
  ProjectDetailResponse,
} from '@polycast/contracts';
import { Button, Stepper } from '@polycast/ui';
import { api } from '@/lib/client-api';
import { describeError } from '@/lib/errors';
import { UploadStep } from './upload-step';
import { AnalysisStep } from './analysis-step';
import { TargetsStep, type TargetChoice } from './targets-step';
import { EstimateStep } from './estimate-step';
import { SubmitStep } from './submit-step';

const STEPS = [
  { id: 'upload', label: 'Upload' },
  { id: 'analysis', label: 'Validation & analysis' },
  { id: 'targets', label: 'Targets' },
  { id: 'estimate', label: 'Estimate' },
  { id: 'submit', label: 'Review & submit' },
] as const;

const wizardKey = (projectId: string) => `pc.wizard.${projectId}`;

function readChoices(projectId: string): TargetChoice[] {
  try {
    const raw = sessionStorage.getItem(wizardKey(projectId));
    return raw ? (JSON.parse(raw) as TargetChoice[]) : [];
  } catch {
    return [];
  }
}

export function NewLocalizationWizard({
  capabilities,
}: {
  capabilities: LanguageCapabilitiesResponse;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const projectId = params.get('project');
  const stepParam = Number(params.get('step') ?? '1');
  const step =
    Number.isInteger(stepParam) && stepParam >= 1 && stepParam <= STEPS.length ? stepParam : 1;

  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [choices, setChoices] = useState<TargetChoice[]>([]);
  const [acceptBetaTerms, setAcceptBetaTerms] = useState(false);
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  // A fresh idempotency key per wizard session; retries and double-clicks reuse it (FR-050).
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const go = useCallback(
    (next: number, nextProjectId = projectId) => {
      const q = new URLSearchParams();
      q.set('step', String(next));
      if (nextProjectId) q.set('project', nextProjectId);
      router.replace(`${pathname}?${q.toString()}`);
    },
    [router, pathname, projectId],
  );

  const refreshDetail = useCallback(async () => {
    if (!projectId) return null;
    try {
      const d = await api<ProjectDetailResponse>(`/api/v1/projects/${projectId}`);
      setDetail(d);
      setDetailError(null);
      return d;
    } catch (e) {
      setDetailError(describeError(e));
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    void refreshDetail();
    setChoices(readChoices(projectId));
  }, [projectId, refreshDetail]);

  useEffect(() => {
    if (!projectId) return;
    try {
      sessionStorage.setItem(wizardKey(projectId), JSON.stringify(choices));
    } catch {
      /* ignore */
    }
  }, [projectId, choices]);

  // Guard: steps past the first need a project.
  useEffect(() => {
    if (step > 1 && !projectId) go(1, null);
  }, [step, projectId, go]);

  const hasVideo = detail?.analysis?.hasVideo ?? Boolean(detail?.asset?.metadata?.video);
  const sourceLocale = detail?.analysis?.confirmedLocale ?? detail?.project.sourceLocale ?? null;

  const jobRequest = useMemo<CreateJobRequest | null>(() => {
    if (!projectId || choices.length === 0) return null;
    return {
      projectId,
      targets: choices.map((c) => ({ locale: c.locale, lipSync: c.lipSync && hasVideo })),
      acceptBetaTerms,
    };
  }, [projectId, choices, acceptBetaTerms, hasVideo]);

  const submit = useCallback(async () => {
    if (!jobRequest) throw new Error('Nothing to submit');
    const res = await api<JobResponse>('/api/v1/localization-jobs', {
      method: 'POST',
      body: jobRequest,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    try {
      sessionStorage.removeItem(wizardKey(jobRequest.projectId));
    } catch {
      /* ignore */
    }
    router.push(`/projects/${res.job.projectId}`);
  }, [jobRequest, idempotencyKey, router]);

  return (
    <div className="stack">
      <Stepper steps={STEPS} current={step - 1} label="Wizard steps" onSelect={(i) => go(i + 1)} />
      {detailError && (
        <div className="alert" role="alert">
          {detailError}
        </div>
      )}

      {step === 1 && (
        <UploadStep
          projectId={projectId}
          existingAsset={detail?.asset ?? null}
          onProjectCreated={(id) => go(1, id)}
          onUploaded={async (id) => {
            // The project may have been created in this same click, so take the id from the
            // upload step rather than the (possibly stale) search param.
            go(2, id);
          }}
        />
      )}

      {step === 2 && projectId && (
        <AnalysisStep
          projectId={projectId}
          detail={detail}
          locales={capabilities.locales}
          refresh={refreshDetail}
          onBack={() => go(1)}
          onContinue={() => go(3)}
        />
      )}

      {step === 3 && projectId && (
        <TargetsStep
          locales={capabilities.locales}
          sourceLocale={sourceLocale}
          hasVideo={hasVideo}
          choices={choices}
          onChange={setChoices}
          onBack={() => go(2)}
          onContinue={() => {
            setEstimate(null);
            go(4);
          }}
        />
      )}

      {step === 4 && projectId && (
        <EstimateStep
          projectId={projectId}
          choices={choices}
          hasVideo={hasVideo}
          estimate={estimate}
          onEstimate={setEstimate}
          acceptBetaTerms={acceptBetaTerms}
          onAcceptBetaTerms={setAcceptBetaTerms}
          onBack={() => go(3)}
          onContinue={() => go(5)}
        />
      )}

      {step === 5 && projectId && (
        <SubmitStep
          detail={detail}
          request={jobRequest}
          estimate={estimate}
          idempotencyKey={idempotencyKey}
          onBack={() => go(4)}
          onSubmit={submit}
        />
      )}

      {step > 1 && !projectId && (
        <div className="card">
          <p>Start by creating a project and uploading a source file.</p>
          <Button type="button" onClick={() => go(1, null)}>
            Go to upload
          </Button>
        </div>
      )}
    </div>
  );
}
