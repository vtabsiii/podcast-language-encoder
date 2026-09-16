# Traceability

Maps every requirement in `product-spec.md` to where it is (or will be) implemented and the test
that proves it. Status values:

- `scaffolded` — a file on this branch exists and contains a real (if partial) piece of the
  requirement; the "Implementation" column names that file and the "Test" column names an
  existing test. What is missing is stated in the row.
- `planned (Mx)` — nothing exists yet beyond documentation; the path given is the intended
  future location ("will live in …") and the test is the one that will be written.

Existing files as of this branch: `packages/domain/src/{state-machine/job-state.ts,
capabilities/registry.ts, time/media-time.ts, errors/domain-error.ts, ids/uuidv7.ts, roles.ts,
entities.ts}`, `packages/contracts/src/{errors,capabilities,events,media,export-schema}.ts` +
`packages/contracts/schema/*.schema.json`, `packages/ui/src/{tokens.css,button.tsx,status-badge.tsx}`,
`apps/api/src/{app.ts,config.ts,server.ts,openapi-export.ts,plugins/errors.ts,routes/health.ts,
routes/capabilities.ts}` + `apps/api/openapi.json`, `apps/web/app/{layout.tsx,page.tsx,
languages/page.tsx,globals.css}` + `apps/web/lib/api.ts`,
`services/media-worker/polycast_worker/{models.py,mediatime.py,ffprobe.py,config.py,
providers/base.py,providers/mock.py}`, `infra/` (legacy CDK, unchanged).
Existing tests: `packages/domain/test/{job-state,capabilities,media-time,ids-and-roles}.test.ts`,
`packages/contracts/test/contracts.test.ts`, `apps/api/test/app.test.ts`,
`services/media-worker/tests/{test_mediatime,test_ffprobe,test_providers_and_config}.py`,
`infra/test/*.test.ts`.

## Functional requirements

| ID | Implementation (existing file, or intended future location) | Test | Status |
|---|---|---|---|
| FR-001 | will live in `apps/api/src/routes/uploads.ts` and `apps/web/app/(wizard)/upload/` | will be `apps/api/test/uploads.test.ts` + Playwright resume test | planned (M1) |
| FR-002 | `services/media-worker/polycast_worker/ffprobe.py` — `parse_probe_output` incl. VFR and HDR detection; `packages/contracts/src/media.ts` (media metadata schema). Missing: quarantine flow, reject path, size/duration limits | `services/media-worker/tests/test_ffprobe.py`; `packages/contracts/test/contracts.test.ts` | scaffolded (partial) |
| FR-003 | will live in `services/media-worker/polycast_worker/stages/derive_proxy.py`; bucket policy in a future `infra/lib/polycast-storage-stack.ts` | will be `tests/test_derive_proxy.py` + CDK assertion | planned (M1/M2) |
| FR-004 | will be a `LanguageDetector` on `services/media-worker/polycast_worker/providers/base.py` (not yet defined) | will be `tests/test_language_detect.py` | planned (M1 mock, M3 real) |
| FR-005 | `TranscriptionProvider` Protocol in `providers/base.py` with mock in `providers/mock.py`; `Segment`/`Word` types in `packages/domain/src/entities.ts` (µs fields). Missing: stage handler, diarization output shape validation | `services/media-worker/tests/test_providers_and_config.py`; `packages/domain/test/media-time.test.ts` | scaffolded (partial) |
| FR-006 | `FaceTrack`, `Shot`, `VisibleSpeechSegment` types in `packages/domain/src/entities.ts` only; tracker/shot Protocols not yet defined | will be `tests/test_face_tracker.py` | planned (M4) |
| FR-007 | will be a `StemSeparator` Protocol in `providers/base.py` | will be `tests/test_stem_separator.py` | planned (post-M5) |
| FR-010 | `TranslationProvider` Protocol in `providers/base.py` + mock. Missing: stage handler, context window, alignment validation | `tests/test_providers_and_config.py` | scaffolded (partial) |
| FR-011 | will live in `services/media-worker/polycast_worker/qc/entity_check.py` (no `qc/` package yet) | will be `tests/qc/test_entity_check.py` | planned (M3) |
| FR-012 | `TranslationVersion` type in `packages/domain/src/entities.ts` (lineage fields). Missing: persistence, API | will be `apps/api/test/lineage.test.ts` | planned (M1) |
| FR-013 | will live in `polycast_worker/stages/timing.py` | will be `tests/test_timing_fit.py` | planned (M3) |
| FR-014 | will live in `polycast_worker/stages/metadata.py` | will be `tests/test_metadata_localize.py` | planned (post-M5) |
| FR-015 | will live in `apps/api/src/routes/glossary.ts`; `GlossaryVersion` type to be added to `entities.ts` | will be `apps/api/test/glossary.test.ts` | planned (M5) |
| FR-020 | `SpeechProvider` Protocol in `providers/base.py` + mock; `CapabilityRecord` model in `base.py`; registry in `packages/domain/src/capabilities/registry.ts`. Missing: real adapter, per-locale routing | `tests/test_providers_and_config.py`; `packages/domain/test/capabilities.test.ts` | scaffolded (partial) |
| FR-021 | `VoiceAssignment` type in `entities.ts` only; audition API will live in `apps/api/src/routes/voices.ts` | will be `apps/api/test/voices.test.ts` | planned (M3) |
| FR-022 | will live in `polycast_worker/stages/timing.py` | will be `tests/test_timing_fit.py` | planned (M3) |
| FR-023 | will live in `polycast_worker/stages/mix.py` | will be `tests/test_mix_loudness.py` | planned (M3) |
| FR-024 | `ConsentRecord`/`ConsentStatus` and `VoicePolicy` types in `entities.ts` only; gate will live in `apps/api/src/routes/consent.ts` | will be `apps/api/test/consent-gate.test.ts` | planned (M5) |
| FR-025 | will live in `apps/api/src/consent/blocklist.ts` | will be part of `consent-gate.test.ts` | planned (M5) |
| FR-026 | optional style flag on `SpeechProvider` (not yet defined) | will be `tests/test_speech_styles.py` | planned (post-M5) |
| FR-030 | `LipSyncProvider` Protocol in `providers/base.py` + mock. Missing: stage handler, VisibleSpeechSegment scoping | `tests/test_providers_and_config.py` | scaffolded (partial) |
| FR-031 | will live in `polycast_worker/stages/composite.py` and `qc/frame_diff.py` | will be `tests/test_frame_preservation.py` | planned (M4) |
| FR-032 | will live in `polycast_worker/stages/lipsync.py` | will be `tests/test_lipsync_shots.py` | planned (M4) |
| FR-033 | will live in `polycast_worker/qc/face_quality.py` | will be `tests/qc/test_face_quality.py` | planned (M4) |
| FR-034 | nothing exists; gate will live in `packages/domain/src/state-machine/ready-gate.ts` and `polycast_worker/qc/sync_confidence.py` | will be `packages/domain/test/ready-gate.test.ts` | planned (M4) |
| FR-035 | will live in `polycast_worker/stages/lipsync.py` | will be `tests/test_lipsync_fallback.py` | planned (post-M5) |
| FR-036 | will live in `polycast_worker/providers/router.py` | will be `tests/test_model_routing.py` | planned (post-M5) |
| FR-040 | `QualityProvider` Protocol in `providers/base.py` + mock; `QcSeverity` in `entities.ts`. Missing: every actual check (no `qc/` package yet) | `tests/test_providers_and_config.py` | scaffolded (partial) |
| FR-041 | nothing exists; will live in `polycast_worker/stages/qc_report.py` with a schema in `packages/contracts/src/qc-report.ts` | will be `tests/test_qc_report_schema.py` | planned (M1) |
| FR-042 | `packages/domain/src/state-machine/job-state.ts` allows only NEEDS_REVIEW→READY as the approval transition. Missing: the gate itself (issue evaluation, approval authority) | `packages/domain/test/job-state.test.ts` (transition rule) | scaffolded (transition rule only) |
| FR-043 | will live in `apps/api/src/routes/sampling.ts` | will be `apps/api/test/sampling.test.ts` | planned (post-M5) |
| FR-044 | will live in `services/media-worker/benchmark/` + CI job | benchmark harness self-test | planned (M4) |
| FR-050 | `packages/domain/src/state-machine/job-state.ts` (states, `canTransition`, `transition`, `IllegalTransitionError`, `nextHappyPathState`, `weightedProgress`). Missing: orchestrator (local or Step Functions), idempotency keys, stage table | `packages/domain/test/job-state.test.ts` (fast-check property tests over transitions) | scaffolded (transitions only) |
| FR-051 | will live in `packages/domain/src/quotas.ts` and a future `infra/lib/polycast-orchestration-stack.ts` | will be `apps/api/test/quota.test.ts` + CDK assertion | planned (M1/M2) |
| FR-052 | `packages/contracts/src/events.ts` — `TargetStageChangedSchema`, `EVENT_NAMES`, `DomainEventSchema`; emitted to `packages/contracts/schema/domain-event.schema.json`. Missing: SSE hub, publisher, web client | `packages/contracts/test/contracts.test.ts` | scaffolded (event contract only) |
| FR-053 | will live in `packages/domain/src/invalidation/graph.ts` and `apps/api/src/routes/review.ts` | will be `packages/domain/test/invalidation.test.ts` | planned (M1) |
| FR-054 | will live in `polycast_worker/stages/package.py` with `packages/contracts/src/deliverable.ts` | will be `tests/test_package.py` | planned (M1) |
| FR-055 | will be a `Notifier` Protocol (not yet defined) and `apps/api/src/notifications/` | will be `apps/api/test/notifications.test.ts` | planned (M3) |
| FR-056 | will live in `apps/api/src/routes/review-links.ts` | will be `apps/api/test/review-links.test.ts` | planned (M5) |
| FR-057 | `OutputPreset`/`JobSnapshot` types in `entities.ts` only; estimates and ledger will live in `apps/api/src/routes/estimates.ts`, `costs.ts` | will be `apps/api/test/estimates.test.ts` | planned (M1 subset, M5) |
| FR-060 | `packages/domain/src/roles.ts` — `ROLES`, `PERMISSIONS`, `ROLE_PERMISSIONS`, `hasPermission`; `Membership`/`TenantScoped` in `entities.ts`. Missing: auth plugin, route guards, RLS | `packages/domain/test/ids-and-roles.test.ts` | scaffolded (matrix only) |
| FR-061 | will live in `apps/api/src/audit/`; `AuditEvent` type to be added to `entities.ts` | will be `apps/api/test/audit.test.ts` | planned (M1) |
| FR-062 | will live in `apps/api/src/routes/deletion.ts` and `polycast_worker/deletion/` | will be `apps/api/test/deletion.test.ts` | planned (M5) |
| FR-063 | will live in `packages/contracts/src/provenance.ts` and `stages/package.py` | will be `tests/test_provenance_manifest.py` | planned (M1) |
| FR-064 | will live in `apps/api/src/routes/takedown.ts` | will be `apps/api/test/takedown.test.ts` | planned (M5) |
| FR-065 | will live in a future `infra/lib/polycast-auth-stack.ts` and `apps/api/src/routes/scim.ts` | will be `apps/api/test/scim.test.ts` | planned (M5) |

## Non-functional requirements

| ID | Implementation (existing file, or intended future location) | Test | Status |
|---|---|---|---|
| NFR-001 | `apps/api/src/plugins/errors.ts` (no stack traces in envelope) exists; CSP, TLS, secrets, scanning will live in `apps/web/middleware.ts`, future `infra/lib/polycast-*`, CI `security-scan` | `apps/api/test/app.test.ts` (envelope); rest will be `apps/web/test/headers.test.ts` | planned (M2) |
| NFR-002 | `TenantScoped` marker interface in `packages/domain/src/entities.ts` only. Missing: repository scoping, RLS migrations, isolation tests | will be `apps/api/test/tenant-isolation.test.ts` and RLS tests | scaffolded (marker type only) |
| NFR-003 | will be a `dataProcessing` descriptor on `CapabilityRecord` (`providers/base.py`) and `registry.ts`; not present yet | will extend `packages/domain/test/capabilities.test.ts` | planned (M1) |
| NFR-004 | `Organization` type in `entities.ts` (region field to be added); single-region guard will live in `apps/api/src/config.ts` | will be `apps/api/test/region.test.ts` | planned (M1) |
| NFR-005 | will live in future `infra/lib/polycast-storage-stack.ts`, `polycast-data-stack.ts` | will be CDK assertions in `infra/test/` | planned (M2) |
| NFR-006 | Fastify app in `apps/api/src/app.ts` exists; performance work (indexes, proxy bitrate) is future | will be k6 `perf/api-read.js` | planned (M2) |
| NFR-007 | limits will live in `packages/domain/src/limits.ts`; fan-out in future orchestration stack | will be load test `perf/fan-out.js` | planned (M2) |
| NFR-008 | `packages/ui/src/tokens.css` (contrast tokens, focus ring) and `apps/web/app/globals.css` exist. Missing: axe checks, RTL layout verification, keyboard-first review studio | will be Playwright + axe suite | planned (M1) |
| NFR-009 | `direction: 'rtl'` flags on ar-*/ur-PK locales in `packages/domain/src/capabilities/registry.ts`; `dir` attribute set in `apps/web/app/layout.tsx`; `apps/web/app/languages/page.tsx` renders tiers. Missing: ICU message catalog, Intl helpers | `packages/domain/test/capabilities.test.ts` | scaffolded (RTL flags + dir attribute) |
| NFR-010 | `apps/api/src/plugins/errors.ts` sets correlation id on every error response. Missing: redaction logger, OTel, alarms | `apps/api/test/app.test.ts` (correlation id) | planned (M1/M2) |
| NFR-011 | TS strict via `tsconfig.base.json`; Zod → JSON Schema in `packages/contracts/src/export-schema.ts` → `packages/contracts/schema/*.schema.json`; OpenAPI at `apps/api/openapi.json` via `apps/api/src/openapi-export.ts`; Python pydantic models in `polycast_worker/models.py`; provider Protocols + `CapabilityRecord` in `providers/base.py`; fail-closed production config in `apps/api/src/config.ts` and `polycast_worker/config.py`; ADRs in `docs/adr/` | `packages/contracts/test/contracts.test.ts`; `apps/api/test/app.test.ts` (production fail-closed config); `tests/test_providers_and_config.py`; `packages/domain/test/media-time.test.ts` (fast-check on time math) | scaffolded |
| NFR-012 | will live in future `infra/lib/tags.ts`; `UsageEvent` type to be added | will be CDK tag assertion | planned (M2/M5) |
| NFR-013 | `apps/web/package.json` has no browserslist yet; Playwright projects to be added | will be E2E matrix | planned (M1) |
| NFR-014 | will live in future `infra/lib/polycast-data-stack.ts`; `runbooks/restore-database.md` exists | quarterly restore drill; will be `deletion replay` test | planned (M2/M5) |

## Coverage summary

| Status | FR | NFR |
|---|---|---|
| scaffolded (all partial) | 10 (FR-002, 005, 010, 020, 030, 040, 042, 050, 052, 060) | 3 (NFR-002, 009, 011) |
| planned | 45 | 11 |

Nothing is `implemented` on this branch. The scaffolded rows are types, Protocols, mocks, the
transition table and contracts; no stage runs end to end until M1.
