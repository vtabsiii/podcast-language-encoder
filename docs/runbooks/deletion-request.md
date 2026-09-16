# Runbook: deletion request

Scope: a customer (Owner/Admin) or a data subject asks for deletion of a user, speaker, project,
asset or organization. Policy and SLAs: `privacy-and-consent.md` §6; store map:
`architecture.md` §10. Clock: embeddings same day, database/derived within 24 h, everything
within 30 days.

## Symptoms

- Admin uses "Delete" in the UI (creates a `DeletionRequest` automatically; runbook verifies).
- Support ticket from a data subject (needs identity verification by support first).
- Alarm `Polycast/DeletionOverdue` (M5) when a request passes 24 h without progress or 25 days
  without completion.

## Diagnosis

1. List open requests: `[planned CLI, M5] pnpm polycast deletion list --status open` or
   `SELECT id, scope, subject_id, status, created_at FROM deletion_requests WHERE status <> 'completed';`
2. Show progress per store: `pnpm polycast deletion show <requestId>` prints one row per store
   (embeddings, database, derived S3, deliverables S3, source S3, provider copies, backups) with
   `pending | done | failed` and proof reference.
3. For failed stores, read the worker log filtered by `deletionRequestId` (ids only).

## Remediation

Automated path (`pnpm polycast deletion run <requestId>` re-invokes the worker):

1. Embeddings and replica models: DB columns nulled, `derived/{org}/voices/**` and
   `derived/{org}/faces/**` deleted. Must be done same day.
2. Database: hard delete in dependency order (approvals, comments, reviews, QC, renders, speech
   renders, translation versions, target jobs, localization jobs, words, segments, transcripts,
   face tracks, shots, speakers, assets, projects). Consent, audit, usage and cost rows are kept
   with subject fields hashed.
3. Derived and deliverables buckets: delete by prefix `{org}/{project}/` including all versions
   (`aws s3api list-object-versions` + `delete-objects`); disable signed-URL minting for the
   deleted deliverable ids (they are gone from the DB, so minting fails naturally).
4. Source bucket: objects are under object lock (governance). The deletion role has
   `s3:BypassGovernanceRetention`; delete all versions and delete markers.
5. Provider copies: call each adapter's deletion API for artefacts recorded in `provider_artifacts`
   for the subject; record the response as proof. Providers with zero retention record `n/a`.
6. Backups: no action; the request is annotated with the date on which the last backup containing
   the data ages out (35 days from the DB deletion). If a restore happens before that date,
   `restore-database.md` step "replay deletions" re-applies this request.
7. Mark completed; the requester receives the report generated from the proof rows.

Manual fallbacks if a store fails: run the equivalent AWS CLI commands with the deletion role and
attach output (object counts only) to the request via
`pnpm polycast deletion proof add <requestId> --store <name> --note "<text>"`.

## Rollback

There is none for completed stores; that is the point. Before step 4 (source bucket) the source
asset is still recoverable through S3 versioning for the 30-day hold on organization deletions; an
Owner can cancel an organization deletion during the hold with `pnpm polycast deletion cancel`.
Project and asset deletions have no hold.

## Escalation

- Request cannot complete within 30 days (e.g. provider deletion API down): privacy lead before
  day 25 so the requester is informed in time.
- Legal hold on the organization (takedown escalated to legal): the deletion is paused with
  status `legal_hold`; only the privacy lead can resume; requester informed by support.
- Evidence that deleted content is still accessible (e.g. a working signed URL): Sev1 privacy
  incident, engineering manager and privacy lead, preserve logs.
