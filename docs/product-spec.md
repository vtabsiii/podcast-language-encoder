# Polycast Studio — Product Specification (condensed)

Status: v0.1, scaffold phase. Nothing is deployed. All provider adapters are unimplemented.

## 1. Product definition

Polycast Studio is a multi-tenant SaaS that takes a finished podcast episode (audio, or video with
on-camera hosts) and produces localized versions in other languages: translated, re-voiced,
optionally lip-synced for visible speakers, re-mixed to broadcast loudness, captioned, and packaged
with a provenance manifest. It is built for producers who publish the same episode in several
markets and need a review workflow, not a one-shot converter.

The existing S3 → Step Functions → Transcribe → Lambda (Translate + Polly) → S3 pipeline in
`infra/` is the "legacy encoder". Polycast replaces it incrementally (see
`implementation-plan.md`); it is not deleted in this phase.

## 2. Goals and non-goals

Goals

- Produce target-language episodes whose dialogue timing, loudness and captions meet the quality
  targets in §8 without manual audio work in most cases.
- Make every step reviewable and regenerable at segment granularity; nothing ships without the
  Ready gate.
- Keep tenant data isolated, retained by policy, deletable on request, and never used for training.
- Expose every language as an explicit capability tier so customers know what they are buying.

Non-goals (v1)

- Live or near-real-time dubbing.
- Music or singing translation; lyric replacement.
- Full-body or off-screen speaker video synthesis; only the active visible speaker's mouth region.
- Hosting or distributing the published feed (we produce deliverables; the customer's CMS ships them).
- Custom model training per tenant.

## 3. Success metrics

| Metric | Target (12 months after GA) |
|---|---|
| Target jobs reaching READY without human edit | ≥ 70% for production-tier languages |
| Median producer time in review studio per 60-min episode | ≤ 25 min |
| QC auto-flag precision (flag was a real defect) | ≥ 85% |
| Target job cost vs. estimate | within ±15% for 95% of jobs |
| Control-plane availability | 99.9% monthly |
| Support tickets per 100 target jobs | ≤ 3 |

## 4. Users and roles

| Role | Typical person | Can |
|---|---|---|
| Owner | Founder / studio head | Everything Admin can, plus billing, org deletion, SSO config |
| Admin | Ops lead | Manage members, consent records, retention policy, budgets, voices |
| Producer | Show producer | Create projects, upload, configure targets, run jobs, approve |
| Reviewer | Native-language reviewer, often external | Open review studio, comment, request regeneration, approve segments; cannot start jobs |
| Viewer | Client, marketing | View project status and download deliverables |

Membership is per Organization. A user can belong to several organizations with different roles.
Review links (FR-056) grant Reviewer scope on a single TargetJob without a full membership.

## 5. Language strategy and capability tiers

Every (source locale, target locale, capability) triple has a tier from the capability registry
(`packages/domain`, `ProviderCapability` entity):

| Tier | Meaning | UI treatment |
|---|---|---|
| production | Passed the benchmark gate in `quality-benchmark.md`; SLA applies | Selectable by default |
| beta | Adapter exists or is mocked; not benchmarked; no SLA | Selectable with a "beta" badge and confirmation; excluded from estimates' accuracy guarantee |
| unavailable | No adapter, or blocked by policy/licensing | Not selectable; shown greyed with reason |

Seed locales (15 language groups, 22 locale codes): en-US/en-GB, es-419/es-MX/es-ES, zh-CN, hi-IN,
ar-001/ar-SA, pt-BR/pt-PT, fr-FR/fr-CA, de-DE, ja-JP, ko-KR, id-ID, bn-IN/bn-BD, ur-PK, ru-RU,
tr-TR. **Every target is seeded as `beta`; none is `production` until it passes the benchmark.**
Regional variants share translation memory by language but have separate voice pools and
separate benchmark results. RTL locales (ar-*, ur-PK) drive RTL caption rendering and UI mirroring.

## 6. Experience architecture

1. **Dashboard** — projects list per organization, per-project status chips per target locale,
   budget burn, items needing review, recent audit events.
2. **New localization wizard (5 steps)** — (1) Upload or import source, (2) Validation & analysis
   summary (duration, speakers, visible speakers, language detected), (3) Choose targets with
   tier badges and per-target options (voice mapping, lip-sync on/off, replica consent check),
   (4) Estimate and budget confirmation, (5) Review configuration and submit → creates the
   LocalizationJob idempotently.
3. **Processing view** — live stage timeline per TargetJob driven by SSE; retry/cancel; cost so far.
4. **Review studio** — waveform + video player, segment list with QC issues, side-by-side source /
   translation / rendered speech, per-segment regenerate (translation, voice, timing, lip-sync),
   comments, approve. Keyboard-first, RTL-aware.
5. **Deliverables** — per target: MP4/MP3, SRT/VTT, transcript JSON, QC report, provenance
   manifest, checksums; download or signed link; package as ZIP.
6. **Admin** — members and roles, consent vault, voices, glossary/TM, retention policy, budgets,
   audit log, takedown queue, SSO/SCIM (P1).

## 7. Functional requirements

Priority: P0 = required for commercial v1; P1 = required for GA; P2 = later.

### Ingest and analysis

| ID | P | Requirement |
|---|---|---|
| FR-001 | P0 | Resumable multipart uploads (S3 multipart; MinIO locally); parts retryable; upload survives page reload. |
| FR-002 | P0 | Validation of uploaded media via ffprobe in a quarantined bucket: container, codecs, duration, channel layout, sample rate, video presence; reject unsupported or malformed files with a typed error. |
| FR-003 | P0 | Source asset is immutable after validation; system derives a low-bitrate proxy and a peak waveform JSON for the review studio. |
| FR-004 | P0 | Source language detection with confidence; producer confirms or overrides in wizard step 2. |
| FR-005 | P0 | Word-level timestamps (integer microseconds) and speaker diarization producing Speaker, Segment, Word rows. |
| FR-006 | P0 | Face tracks and per-shot "active visible speaker" labelling for video sources (FaceTrack, Shot, VisibleSpeechSegment). |
| FR-007 | P1 | Dialogue / music-and-effects stem separation to protect beds during remix. |

### Translation

| ID | P | Requirement |
|---|---|---|
| FR-010 | P0 | Contextual, timed translation per Segment with surrounding context and speaker identity; output stays aligned to source segment ids. |
| FR-011 | P0 | Preserve named entities, numbers, URLs, product names and glossary terms; violations become QC issues. |
| FR-012 | P0 | Translation lineage: every TranslationVersion records provider, model, prompt hash, parent version, and editor. |
| FR-013 | P0 | Duration constraint: translated segment estimated speech duration must fit the source slot within tolerance; retranslate with a "shorter" hint before falling back to speed adjustment. |
| FR-014 | P1 | Localized episode metadata (title, description, chapters, show notes). |
| FR-015 | P1 | Translation memory and per-organization glossary (GlossaryVersion), applied before LLM translation. |

### Speech synthesis

| ID | P | Requirement |
|---|---|---|
| FR-020 | P0 | TTS adapter per production language via the provider Protocol; adapter choice is per target locale in the capability registry. |
| FR-021 | P0 | Per-language voice mapping per Speaker with audition clips before the job runs (VoiceAssignment). |
| FR-022 | P0 | Duration matching: rendered speech is fit into the segment slot by retranslation, rate adjustment (bounded ±12%), or boundary shift within ±120 ms. |
| FR-023 | P0 | Remix synthesized dialogue over the original bed; loudness normalize to §8 targets; true-peak limit. |
| FR-024 | P0 | Voice replica (cloning) is off by default and unlocks only when a verified ConsentRecord exists for that Speaker and target use. |
| FR-025 | P0 | Impersonation block: replicas cannot be created from speakers without consent, from public figures on the block list, or from uploaded reference audio not tied to a consented Speaker. |
| FR-026 | P1 | Emotion / emphasis controls per segment (style tags passed to adapters that support them). |

### Lip sync

| ID | P | Requirement |
|---|---|---|
| FR-030 | P0 | Lip sync runs only on the active visible speaker per shot; other faces untouched. |
| FR-031 | P0 | Preserve identity and background: pixels outside the mouth region are byte-identical to the source frame. |
| FR-032 | P0 | Shot-boundary aware processing: models are invoked per Shot, never across cuts. |
| FR-033 | P0 | Flag occlusion, profile angle, small faces, motion blur, and multi-face ambiguity as QC issues instead of guessing. |
| FR-034 | P0 | Sync confidence gate: a lip-synced Render below threshold is routed to NEEDS_REVIEW, not READY. |
| FR-035 | P1 | Fallback modes per segment: audio-only dub, still-frame hold, or original mouth. |
| FR-036 | P1 | Model routing by shot characteristics (resolution, face size, motion). |

### Quality control

| ID | P | Requirement |
|---|---|---|
| FR-040 | P0 | Automated QC checks: missing/duplicate dialogue, A/V offset, boundary drift, loudness, true peak, caption timing, video frame preservation, entity preservation. |
| FR-041 | P0 | QC report per TargetJob: machine-readable JSON plus human summary, included in deliverables. |
| FR-042 | P0 | Ready gate: a TargetJob reaches READY only if every P0 check passes or a Reviewer with authority has approved each open QCIssue. |
| FR-043 | P1 | Blind native-speaker sampling: randomly sampled segments sent to human raters without the source shown. |
| FR-044 | P1 | Regression benchmark run on every provider/model change (see `quality-benchmark.md`). |

### Workflow and delivery

| ID | P | Requirement |
|---|---|---|
| FR-050 | P0 | Durable, idempotent workflows: every stage is a retry-safe task keyed by (targetJobId, stage, attempt); re-running a stage never duplicates side effects. |
| FR-051 | P0 | Parallel fan-out of TargetJobs from one LocalizationJob with per-organization and per-provider concurrency quotas. |
| FR-052 | P0 | Stage events streamed to the UI over SSE (WebSocket optional later) from the event catalog. |
| FR-053 | P0 | Segment regeneration: any segment can be regenerated at translation, speech, timing or lip-sync stage; downstream artefacts are invalidated per the invalidation graph. |
| FR-054 | P0 | Packaging: deliverable set per target with checksums and provenance manifest. |
| FR-055 | P0 | Notifications: email and in-app on review required, ready, failed, budget threshold. |
| FR-056 | P1 | Review links: expiring, scoped, optionally password-protected links for external reviewers. |
| FR-057 | P1 | Estimates before submit, budgets per project, cost ledger per TargetJob (UsageEvent, CostLedger). |

### Tenancy, governance, compliance

| ID | P | Requirement |
|---|---|---|
| FR-060 | P0 | Multi-tenant organizations with roles Owner/Admin/Producer/Reviewer/Viewer enforced at API and query level. |
| FR-061 | P0 | Audit events for every mutating action and every access to media/transcripts. |
| FR-062 | P0 | Retention policy per organization; deletion requests remove media, derived artefacts, transcripts and provider-side copies within SLA. |
| FR-063 | P0 | Provenance manifest and disclosure metadata embedded in every deliverable (synthetic voice, lip-sync applied, models used). |
| FR-064 | P0 | Takedown workflow: report → hold → review → remove, with notification to the organization. |
| FR-065 | P1 | SSO (OIDC/SAML) and SCIM provisioning. |

## 8. Quality targets

| Dimension | Target | On miss |
|---|---|---|
| Dialogue coverage | No missing or duplicated dialogue > 300 ms | QC issue, blocks READY |
| A/V offset (lip-synced segments) | Median ≤ 45 ms, p95 ≤ 100 ms | Route to NEEDS_REVIEW |
| Segment boundary drift vs source | ± 120 ms | QC issue |
| Integrated loudness | −16 LUFS stereo, −19 LUFS mono, ± 1 LU | Auto-renormalize; issue if still out |
| True peak | ≤ −1 dBTP | Auto-limit; issue if still out |
| Caption timing vs rendered speech | within 100 ms | QC issue |
| Video preservation outside mouth region | Byte-identical frames (critical) | Blocks READY, no override |
| Control-plane availability | 99.9% monthly | SLO alarm |
| Disaster recovery | RPO 15 min, RTO 4 h | See `runbooks/restore-database.md` |

## 9. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-001 | Security | OWASP ASVS L2; all traffic TLS 1.2+; secrets in AWS Secrets Manager; signed URLs ≤ 15 min; CSP on web; dependency and container scanning in CI. |
| NFR-002 | Tenant isolation | Every table carries `organization_id`; row-level security in Postgres plus mandatory tenant scope in the repository layer; per-tenant S3 key prefixes; cross-tenant access tests run in CI. |
| NFR-003 | Privacy / no-training | Customer media, transcripts and voices are never used to train models by us or providers; provider contracts must have no-training and zero-retention terms; documented in `privacy-and-consent.md`. |
| NFR-004 | Residency | Data stays in the organization's chosen region (us-east-1 only in v1; region field reserved). |
| NFR-005 | Durability | Source assets in S3 with versioning and object lock (compliance mode off, governance on); database PITR; 11 nines object durability. |
| NFR-006 | Performance | API p95 < 300 ms for control-plane reads; SSE event delivery < 2 s after stage change; review studio seeks < 200 ms on proxy. |
| NFR-007 | Scale | 100 concurrent source jobs, 1,000 concurrent target branches, sources up to 4 h / 100 GB. |
| NFR-008 | Accessibility | WCAG 2.2 AA; full keyboard operation of review studio; RTL layout for ar-*, ur-PK; axe checks in E2E. |
| NFR-009 | Localization | UI strings externalized (ICU MessageFormat); UI in en-US at v1; dates/numbers via Intl. |
| NFR-010 | Observability | Structured JSON logs with traceId/orgId/jobId, OpenTelemetry traces across API → Step Functions → workers, RED metrics per stage, alarms on DLQ depth, stage latency, error rate. |
| NFR-011 | Maintainability | TS strict, Zod contracts as single source of truth exported to JSON Schema for Python; ADRs for every architectural decision; ≥ 80% unit coverage in domain and contracts. |
| NFR-012 | FinOps | Cost allocation tags (org, project, targetJob, stage) on every resource; per-job cost ledger; budget alarms. |
| NFR-013 | Browsers | Last 2 versions of Chrome, Edge, Firefox, Safari; no IE; mobile Safari read-only dashboard. |
| NFR-014 | Recovery | RPO 15 min, RTO 4 h; restore drill quarterly; runbook-driven. |

## 10. Business rules

- BR-01 A TargetJob cannot enter QUEUED unless the organization has budget headroom ≥ estimate (or budgets are disabled).
- BR-02 A replica voice can be used only while the matching ConsentRecord is `active`; revocation invalidates renders and blocks packaging (`runbooks/consent-revocation.md`).
- BR-03 Deliverables are immutable once packaged; regeneration produces a new Deliverable version.
- BR-04 Reviewer approvals are per segment and per TargetJob version; a regeneration clears approvals on affected segments only.
- BR-05 Beta-tier targets are billed but explicitly excluded from quality SLAs.
- BR-06 Deleting a Project deletes all derived artefacts; deleting an Organization deletes everything after a 30-day hold (Owner only).
- BR-07 Audit events are append-only and retained 7 years regardless of retention policy.
- BR-08 Every deliverable includes the provenance manifest; customers cannot opt out of the manifest, only of visible on-screen disclosure.
