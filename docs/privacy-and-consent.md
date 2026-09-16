# Privacy and consent

Polycast processes people's voices and faces. This document is the policy the code enforces; the
threat model lists the tests, the runbooks describe operator actions.

## 1. Data classes

| Class | Examples | Handling |
|---|---|---|
| C0 Public | Marketing site, capability matrix | No controls |
| C1 Internal | Job metadata, stage timings, cost ledger | Tenant-scoped, logged with ids only |
| C2 Confidential | Project names, episode metadata, comments, glossaries | Tenant-scoped, encrypted at rest, in logs only as ids |
| C3 Content | Source media, proxies, transcripts, translations, rendered audio/video, deliverables | Never logged, never leaves region, signed URLs only, provider zero-retention |
| C4 Biometric | Voice embeddings, face embeddings, face tracks, replica models, consent evidence | C3 plus: encrypted columns with per-org KMS key, deleted first in any deletion, never exported to providers except the specific synthesis call, access audited per read |

## 2. ConsentRecord

| Field | Type | Notes |
|---|---|---|
| id | uuidv7 | |
| organizationId | uuidv7 | Owner org |
| speakerId | uuidv7 | The diarized Speaker this consent covers |
| subjectName | text (encrypted) | Legal name of the person |
| subjectContact | text (encrypted) | Email or phone for verification and revocation |
| scope | enum[] | `replica_voice`, `lip_sync`, `translation_dub`, `redistribution` |
| targetLocales | text[] or `*` | Locales the consent covers |
| evidenceType | enum | `signed_document`, `recorded_statement`, `platform_click`, `contract_reference` |
| evidenceRef | text | S3 key in the consent vault (C4), never a public URL |
| verifiedBy | uuidv7 | User who verified; Admin/Owner only |
| verifiedAt | timestamptz | |
| status | enum | `pending`, `active`, `revoked`, `expired` |
| validFrom / validUntil | timestamptz | Expiry drives `expired` via nightly job |
| revokedAt / revokedReason | | Set on revocation; immutable afterwards |
| createdAt / updatedAt | | |

Consent records are retained 7 years after revocation (legal basis evidence) with the subject
fields retained; they are not deleted by deletion requests, only by the legal-hold process.

## 3. Replica gating rules

1. `replica` is a per-VoiceAssignment flag, default `false`. The wizard shows it disabled unless an
   `active` ConsentRecord exists for that Speaker with scope `replica_voice` and a matching locale.
2. Job creation re-validates consent server-side (never trust the UI); missing consent → `ConsentRequiredError` (HTTP 409).
3. Reference audio for a replica is taken only from the Speaker's own diarized segments in the
   consented Asset; uploading separate reference audio is not supported in v1 (FR-025).
4. A public-figure blocklist (name and voice-embedding similarity) rejects replica creation; matches
   are logged as audit events with a hash, not the embedding.
5. Revocation (`consent.revoked`) immediately: invalidates all SpeechRender/Render that used the
   replica, blocks PACKAGING on affected TargetJobs, deletes the replica model, and notifies the org.
   Already-downloaded deliverables cannot be recalled; the org is told so in the notification.
6. Expiry behaves like revocation but with a 14-day warning notification.

## 4. No-training policy

- Polycast does not train, fine-tune, or evaluate models on customer content (C3/C4). Benchmark
  corpora are licensed or synthetic and live in a separate account.
- Every provider integration must have contractual terms for: no training on our inputs, zero or
  ≤ 24 h retention, deletion API or documented purge, region pinning, subprocessors list.
- Adapters carry a `dataProcessing` descriptor (`{ noTraining: true, retentionHours, region,
  deletionApi }`); the capability registry refuses to mark a capability `beta` or `production` if
  any field is missing. This is checked by a unit test in `packages/domain`.

## 5. Provider data-processing requirements

| Requirement | Amazon Transcribe / Translate / Polly | LLM adapter | Lip-sync vendor | Second TTS vendor |
|---|---|---|---|---|
| No training on inputs | AWS service terms (opt-out confirmed at account level) | Contract required | Contract required | Contract required |
| Retention | Job outputs to our bucket; service-side ≤ documented | Zero retention | Zero retention | ≤ 24 h |
| Region | us-east-1 | us-east-1 or Bedrock | us-east-1 (self-hosted on Batch preferred) | us-east-1 |
| Deletion | Delete job / S3 | n/a (no retention) | API + proof | API + proof |
| Biometric transfer | Audio only | None (text only) | Face crops of consented speaker only | Audio of consented speaker only |
| Status | Planned M3 | Planned M3 | Planned M4 | Planned M3+ |

## 6. Retention and deletion workflow

Retention defaults per store are in `architecture.md` §10. Organizations can shorten, never
extend beyond plan maximum.

Deletion request (user, project, speaker, or organization scope):

1. Admin/Owner submits request; API creates `DeletionRequest` (status `received`) and audit event.
2. Immediate: C4 embeddings and replica models deleted; consent records marked `subject_deleted` (retained, subject fields replaced by a hash).
3. Within 24 h: derived artefacts, deliverables, transcripts, translations, comments removed; DB rows hard-deleted.
4. Within 30 d: source assets and all S3 versions deleted (object lock governance bypass by the deletion role only); provider deletion APIs called; `DeletionProof` rows written per store.
5. Backups age out at 35 d; the proof states this explicitly. Restoring a backup re-runs pending deletions from the `DeletionRequest` table before the database is opened to traffic (`runbooks/restore-database.md`).
6. Request closes with a report to the requester. Operator steps: `runbooks/deletion-request.md`.

## 7. Takedown and reporting flow

Anyone (including non-users) can report a deliverable or a voice via the public reporting endpoint
or support. Flow:

1. Report creates a `TakedownCase` with the reported subject (deliverable, speaker, project) and reason (impersonation, no consent, copyright, other).
2. Automatic hold: affected deliverables' signed-URL minting is disabled; new packaging blocked; org notified within 1 h.
3. Review by Polycast trust team within 2 business days; org can respond with evidence (e.g. consent record).
4. Outcome: `dismissed` (hold lifted), `removed` (deliverables deleted, replica deleted, audit), or `escalated` (legal).
5. Repeat findings against one organization trigger account review.

## 8. Disclosure and provenance manifest

Every deliverable set includes `provenance.json` (schema in `packages/contracts`):

```json
{
  "version": "1",
  "deliverableId": "…",
  "sourceAsset": { "id": "…", "sha256": "…", "durationUs": 3600000000 },
  "targetLocale": "es-MX",
  "synthetic": { "voice": true, "voiceReplica": false, "lipSync": true },
  "speakers": [{ "speakerId": "…", "voice": "polly:Lupe", "replica": false, "consentRecordId": null }],
  "models": [{ "stage": "TRANSLATING", "provider": "amazon-translate", "version": "…" }],
  "qcReportSha256": "…",
  "generatedAt": "…",
  "generator": "polycast-studio/0.1.0"
}
```

- The manifest is also embedded as metadata in MP4 (`©cmt`/custom atom) and MP3 (ID3 TXXX) and
  referenced by a C2PA-style claim when the toolchain supports it (planned).
- Organizations may disable the on-screen/audio disclosure but not the manifest (BR-08).
- The QC report and manifest hashes appear in `checksums.sha256` so a customer can verify them.
