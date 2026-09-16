# ADR-0005: Provider strategy

Status: Accepted

## Context

Transcription, translation, speech synthesis, lip sync, encoding and QC each have several
candidate providers whose quality varies by language and changes over time. We must be able to
swap providers per locale, keep customers informed of what is reliable, enforce privacy terms,
and never ship a locale whose quality we have not measured. The legacy encoder hard-codes
Transcribe, Translate and Polly.

## Decision

1. **Adapters.** Every capability is a Python `Protocol` in
   `services/media-worker/polycast_worker/providers/base.py` (today: `TranscriptionProvider`,
   `TranslationProvider`, `SpeechProvider`, `LipSyncProvider`, `MediaEncodeProvider`,
   `QualityProvider`; to be added: `LanguageDetector`, `TimingFitter`, `Mixer`, `FaceTracker`,
   `ShotDetector`, `StemSeparator`, `Notifier`) with a matching TypeScript
   interface in `packages/domain` for the parts the API needs (capability lookup, cost estimation).
   Adapters are pure functions of typed inputs to typed outputs plus a `dataProcessing` descriptor;
   they receive S3 keys, never bytes over the API. `Mock*` implementations in `providers/mock.py` exist for every
   Protocol defined so far and are the only ones present in this phase.
2. **Capability registry.** `packages/domain` holds `ProviderCapability` rows keyed by
   (sourceLocale, targetLocale, capability) → (adapter id, tier, benchmark run, dataProcessing).
   The API and wizard read tiers from it; workers read adapter routing from it. Seeds: 22 locale
   codes, all `beta`. `Mock*` adapters register as `unavailable`; a dev-only override lets the
   M1 slice route through them without changing the seeded tier. Organizations may have overrides (e.g. a vendor they have a
   contract with) but cannot raise a tier.
3. **Benchmark gate.** Tier changes to `production` happen only through the process in
   `quality-benchmark.md`; a CI job writes benchmark results and a reviewed PR flips the tier.
   Regressions auto-demote.
4. **AWS-native first.** M3 wires Amazon Transcribe, Translate, Polly, MediaConvert because they
   satisfy the data-processing requirements under existing AWS terms; an LLM translation adapter
   (Bedrock) and a second TTS vendor follow. Lip sync (M4) is an open decision between a licensed
   model self-hosted on GPU Batch (preferred for biometric data handling) and a vendor API. The
   first adapter is the vendor API route (sync.so `lipsync-2`, `providers/synclabs.py`), chosen so
   the end-to-end path can be exercised before a GPU Batch model is licensed. It registers at
   tier `beta` and stays there: promotion needs the benchmark gate (A/V offset, sync confidence,
   frame preservation), the vendor's data-processing descriptor and a signed contract, none of
   which exist yet, and the adapter has not been run against the live service from this
   repository. Source video and the dubbed speech track leave AWS for the vendor over presigned
   HTTPS URLs (`PROVIDER_URL_TTL_SECONDS`), which the privacy review must cover before any
   customer target uses it.

## Consequences

- Positive: locale-by-locale provider choice; honest tiers in the product; privacy terms enforced
  by the registry refusing incomplete descriptors; mocks let the entire pipeline run in M1 and in
  CI; contract tests with recorded responses catch vendor drift.
- Negative: adapters flatten provider-specific features to the Protocol; features like emotion
  tags (FR-026) need optional capability flags on the Protocol. Maintaining recorded fixtures per
  provider is ongoing work. Two implementations of the capability model (TS and Python) are kept in
  sync via the shared JSON Schema and a CI check that the seed file validates in both.
- Rejected a single "best" provider per capability (quality varies too much across the 15 seed
  languages) and letting customers pick providers directly (moves the quality problem to them and
  breaks the benchmark gate).
