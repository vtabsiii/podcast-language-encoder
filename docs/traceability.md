# Traceability

Maps every requirement in `product-spec.md` to where it is (or will be) implemented and the test
that proves it. Status values:

- `scaffolded` — a file on this branch exists and contains a real (if partial) piece of the
  requirement; the "Implementation" column names that file and the "Test" column names an
  existing test. What is missing is stated in the row.
- `planned (Mx)` — nothing exists yet beyond documentation; the path given is the intended
  future location ("will live in …") and the test is the one that will be written.
- `implemented (M1 …)` — the requirement works end to end on the local slice with the tests
  named; qualifiers such as "mock" or "subset" say exactly what is still to come.

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
| FR-001 | `apps/api/src/services/uploads.ts` + `storage/{local-fs,s3}.ts` (multipart init/sign/complete/abort, resume by project+file+size); `apps/web/lib/upload.ts` (retry, pause/resume, localStorage resume) | `apps/api/test/slice.test.ts`; `apps/web/lib/upload.test.ts`; E2E | implemented (M1) |
| FR-002 | `services/media-worker/polycast_worker/stages/validating.py` (ffprobe or stdlib WAV, typed reject codes, size/duration limits, copy to immutable source); `ffprobe.py` | `services/media-worker/tests/test_stage_units.py`, `test_ffprobe.py`; `apps/api/test/worker-integration.test.ts` | implemented (M1) |
| FR-003 | `stages/analyzing.py` (proxy.mp3 / waveform.json under the derived prefix); source object never rewritten after VALIDATING. Missing: S3 versioning/object lock (M2 storage stack) | `tests/test_e2e_loop.py`; `apps/api/test/worker-integration.test.ts` | implemented (M1, local); planned (M2 bucket policy) |
| FR-004 | Mock detection in `stages/analyzing.py` (declared locale or en-US, confidence 0.93); confirm/override via `POST /projects/:id/confirm-locale` (`apps/api/src/services/projects.ts`); wizard step 2 | `apps/api/test/slice.test.ts`; E2E | implemented (M1 mock, M3 real) |
| FR-005 | Mock transcription fixture with µs word timestamps and two speakers (`stages/analyzing.py`); persisted `speakers`/`source_transcripts`/`segments` by `apps/api/src/orchestrator/local.ts` | `tests/test_stage_units.py`; `apps/api/test/slice.test.ts` | implemented (M1 mock, M3 real) |
| FR-006 | `FaceTrack`, `Shot`, `VisibleSpeechSegment` types in `packages/domain/src/entities.ts` only; tracker/shot Protocols not yet defined | will be `tests/test_face_tracker.py` | planned (M4) |
| FR-007 | will be a `StemSeparator` Protocol in `providers/base.py` | will be `tests/test_stem_separator.py` | planned (post-M5) |
| FR-010 | `MockTranslationProvider` (`providers/mock.py`) + `stages/translating.py` keyed by segment id; `translation_versions` persistence | `tests/test_stage_units.py`; `apps/api/test/slice.test.ts` | implemented (M1 mock, M3 real) |
| FR-011 | will live in `services/media-worker/polycast_worker/qc/entity_check.py` (no `qc/` package yet) | will be `tests/qc/test_entity_check.py` | planned (M3) |
| FR-012 | `translation_versions` (provider, version, prompt version, `supersedes_id`, `generation`, `edited_by_user_id`) in `apps/api/migrations/0001_init.sql`; lineage exposed in `ReviewResponse.history` | `apps/api/test/slice.test.ts` (generation 2 supersedes generation 1) | implemented (M1) |
| FR-013 | will live in `polycast_worker/stages/timing.py` | will be `tests/test_timing_fit.py` | planned (M3) |
| FR-014 | will live in `polycast_worker/stages/metadata.py` | will be `tests/test_metadata_localize.py` | planned (post-M5) |
| FR-015 | will live in `apps/api/src/routes/glossary.ts`; `GlossaryVersion` type to be added to `entities.ts` | will be `apps/api/test/glossary.test.ts` | planned (M5) |
| FR-020 | `MockSpeechProvider` + `stages/synthesizing.py`; registry tiers drive selectability (`apps/api/src/services/jobs.ts` rejects `unavailable`) | `tests/test_stage_units.py`; `apps/api/test/slice.test.ts` | implemented (M1 mock, M3 real) |
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
| FR-040 | `MockQualityProvider` + `stages/target_qa.py` (coverage, loudness, true peak, caption timing, entity preservation; real ebur128 measurement when ffmpeg exists). Missing: A/V offset, boundary drift, frame preservation | `tests/test_e2e_loop.py`; `apps/api/test/slice.test.ts` | implemented (M1 fixture), planned (M3 real checks) |
| FR-041 | `packages/contracts/src/provenance.ts` (`QcReportSchema`) → `schema/qc-report.schema.json`; report built by `LocalOrchestrator.buildQcReport` and written as `qc-report.json` by `stages/packaging.py` | `packages/contracts/test/contracts.test.ts`; `tests/test_models_schema.py`; `apps/api/test/worker-integration.test.ts` | implemented (M1) |
| FR-042 | Ready gate in `apps/api/src/orchestrator/local.ts` (`readyGate`, `tryReady`): READY only with zero open issues and a fresh approval on every segment; approvals go stale on regeneration (BR-04) | `apps/api/test/slice.test.ts` (approve refused while an issue is open) | implemented (M1) |
| FR-043 | will live in `apps/api/src/routes/sampling.ts` | will be `apps/api/test/sampling.test.ts` | planned (post-M5) |
| FR-044 | will live in `services/media-worker/benchmark/` + CI job | benchmark harness self-test | planned (M4) |
| FR-050 | `stage_tasks` queue keyed by (subject, stage, run, attempt) (`apps/api/src/orchestrator/tasks.ts`); every transition through `transition()` (`orchestrator/transitions.ts`); `Idempotency-Key` on job creation (`apps/api/src/idempotency.ts`); retry with backoff → RETRY_WAIT → FAILED | `apps/api/test/slice.test.ts` (replay, conflict, retry, exhaustion) | implemented (M1 local orchestrator; Step Functions M2) |
| FR-051 | Fan-out in `apps/api/src/services/jobs.ts`; `packages/domain/src/quotas.ts` (`maxConcurrentTargetJobs`, `maxTargetsPerJob`) | `packages/domain/test/quotas-and-estimate.test.ts`; `apps/api/test/slice.test.ts` | implemented (M1, org quota only; per-provider quotas M3) |
| FR-052 | Outbox `domain_events` + `pg_notify` (`apps/api/src/events/outbox.ts`), `EventHub` LISTEN fan-out, `GET /api/v1/events` SSE with `Last-Event-ID` replay (`routes/events.ts`); web `useProjectEvents` | `apps/api/test/events.test.ts` (< 2 s, tenant filtered, replay) | implemented (M1) |
| FR-053 | `packages/domain/src/invalidation/graph.ts` (`planRegeneration`) applied by `LocalOrchestrator.regenerate`; `POST /target-jobs/:id/segments/:segmentId/regenerate`; scoped stages carry only the affected segments | `packages/domain/test/invalidation.test.ts`; `apps/api/test/slice.test.ts` | implemented (M1) |
| FR-054 | `stages/packaging.py` (media, SRT, VTT, transcript JSON, QC report, provenance manifest, `checksums.sha256`); `deliverables` rows per package version; signed download links | `tests/test_e2e_loop.py`; `apps/api/test/worker-integration.test.ts` (checksums verified byte for byte) | implemented (M1) |
| FR-055 | will be a `Notifier` Protocol (not yet defined) and `apps/api/src/notifications/` | will be `apps/api/test/notifications.test.ts` | planned (M3) |
| FR-056 | will live in `apps/api/src/routes/review-links.ts` | will be `apps/api/test/review-links.test.ts` | planned (M5) |
| FR-057 | `packages/domain/src/estimate.ts` (fixture rate card, beta uncertainty) + `checkBudget`; `POST /projects/:id/estimate`; budget panel on the dashboard. Missing: usage events and cost ledger | `packages/domain/test/quotas-and-estimate.test.ts`; `apps/api/test/slice.test.ts` | implemented (M1 subset), planned (M5 ledger) |
| FR-060 | `apps/api/src/auth/principal.ts` (token → user → membership → role), `requirePermission` on every route; RLS policies in `migrations/0001_init.sql` | `apps/api/test/tenant-isolation.test.ts` (403 for viewer, 404 cross-tenant) | implemented (M1) |
| FR-061 | `apps/api/src/audit.ts` (append-only `audit_events`, before/after hashes) called from every mutating service and from transcript/review/deliverable access | `apps/api/test/tenant-isolation.test.ts` (append-only grant) | implemented (M1) |
| FR-062 | will live in `apps/api/src/routes/deletion.ts` and `polycast_worker/deletion/` | will be `apps/api/test/deletion.test.ts` | planned (M5) |
| FR-063 | `packages/contracts/src/provenance.ts` → `schema/provenance-manifest.schema.json`; `stages/packaging.py` writes `provenance.json` (`mock`, `disclosure`, models, checksums); `GET /target-jobs/:id/deliverables/manifest` | `packages/contracts/test/contracts.test.ts`; `tests/test_models_schema.py`; E2E disclosure | implemented (M1) |
| FR-064 | will live in `apps/api/src/routes/takedown.ts` | will be `apps/api/test/takedown.test.ts` | planned (M5) |
| FR-065 | will live in a future `infra/lib/polycast-auth-stack.ts` and `apps/api/src/routes/scim.ts` | will be `apps/api/test/scim.test.ts` | planned (M5) |

## Non-functional requirements

| ID | Implementation (existing file, or intended future location) | Test | Status |
|---|---|---|---|
| NFR-001 | `apps/api/src/plugins/errors.ts` (no stack traces in envelope) exists; CSP, TLS, secrets, scanning will live in `apps/web/middleware.ts`, future `infra/lib/polycast-*`, CI `security-scan` | `apps/api/test/app.test.ts` (envelope); rest will be `apps/web/test/headers.test.ts` | planned (M2) |
| NFR-002 | `organization_id` on every tenant table with `ENABLE`/`FORCE ROW LEVEL SECURITY` and `app_org_id()` policies (`migrations/0001_init.sql`); `Db.withTenant` sets the scope per transaction; tenant-prefixed object keys (`storage/driver.ts#tenantKey`) | `apps/api/test/tenant-isolation.test.ts` (every route + raw SQL) | implemented (M1) |
| NFR-003 | will be a `dataProcessing` descriptor on `CapabilityRecord` (`providers/base.py`) and `registry.ts`; not present yet | will extend `packages/domain/test/capabilities.test.ts` | planned (M1) |
| NFR-004 | `Organization` type in `entities.ts` (region field to be added); single-region guard will live in `apps/api/src/config.ts` | will be `apps/api/test/region.test.ts` | planned (M1) |
| NFR-005 | will live in future `infra/lib/polycast-storage-stack.ts`, `polycast-data-stack.ts` | will be CDK assertions in `infra/test/` | planned (M2) |
| NFR-006 | Fastify app in `apps/api/src/app.ts` exists; performance work (indexes, proxy bitrate) is future | will be k6 `perf/api-read.js` | planned (M2) |
| NFR-007 | limits will live in `packages/domain/src/limits.ts`; fan-out in future orchestration stack | will be load test `perf/fan-out.js` | planned (M2) |
| NFR-008 | Semantic screens with labelled controls, live regions, keyboard-first review studio, `dir` on RTL text; `packages/ui` primitives | `apps/web/e2e/slice.spec.ts` (axe wcag2a/2aa/22aa on every screen) | implemented (M1) |
| NFR-009 | `direction: 'rtl'` flags on ar-*/ur-PK locales in `packages/domain/src/capabilities/registry.ts`; `dir` attribute set in `apps/web/app/layout.tsx`; `apps/web/app/languages/page.tsx` renders tiers. Missing: ICU message catalog, Intl helpers | `packages/domain/test/capabilities.test.ts` | scaffolded (RTL flags + dir attribute) |
| NFR-010 | Correlation id on every response; redacting logger (`apps/api/src/logging.ts`) drops forbidden keys and URL-like keys; worker `logsafe.py`. Missing: OTel, alarms | `apps/api/test/redaction.test.ts`; `tests/test_logsafe.py` | implemented (M1 logging), planned (M2 traces/alarms) |
| NFR-011 | TS strict via `tsconfig.base.json`; Zod → JSON Schema in `packages/contracts/src/export-schema.ts` → `packages/contracts/schema/*.schema.json`; OpenAPI at `apps/api/openapi.json` via `apps/api/src/openapi-export.ts`; Python pydantic models in `polycast_worker/models.py`; provider Protocols + `CapabilityRecord` in `providers/base.py`; fail-closed production config in `apps/api/src/config.ts` and `polycast_worker/config.py`; ADRs in `docs/adr/` | `packages/contracts/test/contracts.test.ts`; `apps/api/test/app.test.ts` (production fail-closed config); `tests/test_providers_and_config.py`; `packages/domain/test/media-time.test.ts` (fast-check on time math) | scaffolded |
| NFR-012 | will live in future `infra/lib/tags.ts`; `UsageEvent` type to be added | will be CDK tag assertion | planned (M2/M5) |
| NFR-013 | `apps/web/package.json` has no browserslist yet; Playwright projects to be added | will be E2E matrix | planned (M1) |
| NFR-014 | will live in future `infra/lib/polycast-data-stack.ts`; `runbooks/restore-database.md` exists | quarterly restore drill; will be `deletion replay` test | planned (M2/M5) |

## Coverage summary

| Status | FR | NFR |
|---|---|---|
| implemented (M1; mocks and subsets qualified in the row) | 19 (FR-001, 002, 003, 004, 005, 010, 012, 020, 040, 041, 042, 050, 051, 052, 053, 054, 057, 060, 061, 063) | 3 (NFR-002, 008, 010) |
| scaffolded (partial) | 3 (FR-030, NFR-009, NFR-011 as before) | 2 |
| planned | 33 | 9 |

Every provider behind the M1 slice is a `Mock*` adapter registered as tier `unavailable`; the
provenance manifest of every package says so (`mock: true`). Real adapters arrive in M3.
