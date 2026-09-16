# Runbook: provider outage

Applies to any adapter: transcription, translation, TTS, lip sync, encode, notifications.

## Symptoms

- Alarm `Polycast/ProviderErrorRate/<provider>` > 20% over 5 min, or `Polycast/StageLatencyP95`
  on one stage across many organizations.
- Many jobs in RETRY_WAIT with the same error code (`ProviderUnavailableError`, `ProviderThrottledError`).
- Provider status page or AWS Health Dashboard reports an incident.

## Diagnosis

1. Confirm scope: `[planned CLI, M2] pnpm polycast provider status` (error rate, p95, open circuit
   breakers per adapter). Interim:
   `aws logs insights ... | filter provider = "<id>" | stats count() by errorCode` on `/polycast/media-worker`.
2. Throttling vs outage: throttling shows 429/`ThrottlingException`; check
   `aws service-quotas list-service-quotas --service-code transcribe` (or polly/translate) and
   current usage. Outage shows 5xx/timeouts.
3. Check AWS Health: `aws health describe-events --filter services=TRANSCRIBE,POLLY,TRANSLATE,MEDIACONVERT`.
4. Determine which locales are affected from the capability registry:
   `[planned CLI] pnpm polycast capability list --adapter <id>`.

## Remediation

1. Open the circuit breaker so jobs park in RETRY_WAIT instead of burning retries and spend:
   `[planned CLI, M2] pnpm polycast provider pause <adapterId> --reason "<incident>"`.
   Interim: set SSM parameter `/polycast/providers/<adapterId>/paused = true` (workers read it at
   stage start).
2. If a fallback adapter exists at the same tier for the affected locales (registry field
   `fallbackAdapterId`), route to it: `pnpm polycast provider route <capability> <locale> --to <adapterId>`.
   Routing to a lower-tier adapter for a production-tier locale requires the media-plane lead's
   approval and demotes the locale to `beta` for the duration (customers see the badge).
3. Throttling only: request a quota increase and lower the per-provider concurrency in the registry
   so the Map state respects it.
4. Communicate: status page entry naming affected capabilities and locales; notify organizations
   with jobs in RETRY_WAIT via the notification adapter (or SES template `provider-delay`).
5. When the provider recovers: `pnpm polycast provider resume <adapterId>`; RETRY_WAIT jobs resume
   automatically at their next backoff tick. Watch the DLQ for messages that exhausted retries and
   redrive them (`stuck-job.md`).

## Rollback

- Fallback routing is recorded as a registry override with an expiry; `pnpm polycast provider
  route --clear` restores the primary. Any jobs completed on the fallback keep lineage showing the
  fallback provider in the provenance manifest; do not rewrite history.
- Demoted tiers are restored only after the regression smoke corpus passes on the primary again.

## Escalation

- All TTS or all transcription capacity down for > 1 h: Sev1, page engineering manager, customer
  comms through support.
- Provider data incident (breach notice from vendor): stop all traffic to the provider, escalate
  to engineering manager and privacy lead immediately, follow the vendor's incident process,
  record in the audit log.
