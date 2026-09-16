# Runbook: consent revocation

A speaker (or their representative) withdraws consent for voice replica, lip sync or dubbing, or
an Admin discovers a ConsentRecord is invalid. Policy: `privacy-and-consent.md` §3.

## Symptoms

- Support ticket or email from a data subject or the organization.
- Admin uses "Revoke" in the consent vault (this triggers the automated path; the runbook then
  only verifies).
- Takedown case with reason `no_consent` (see `privacy-and-consent.md` §7).
- Alarm `Polycast/ConsentCascadeFailed` (M5) when the automated cascade could not finish.

## Diagnosis

1. Identify the ConsentRecord and Speaker:
   `[planned CLI, M5] pnpm polycast consent show <consentRecordId>` or
   `SELECT id, speaker_id, scope, status, valid_until FROM consent_records WHERE id = '<id>';`
2. Verify the requester's identity against `subjectContact` (support does this; engineers do not
   read the decrypted field, they use `pnpm polycast consent verify-contact --hash <sha256>`).
3. Find affected artefacts:
   `[planned CLI, M5] pnpm polycast consent impact <consentRecordId>` lists VoiceAssignments with
   `replica = true`, SpeechRenders, Renders, TargetJobs (status) and packaged Deliverables that
   used the replica or lip sync of this speaker.

## Remediation

1. Revoke (if not already done by the Admin):
   `[planned CLI, M5] pnpm polycast consent revoke <consentRecordId> --reason "<reason>"`.
   This emits `consent.revoked` and the cascade:
   - VoiceAssignments flip to `replica = false` with `blockedReason = consent_revoked`.
   - SpeechRender/Render rows using the replica are invalidated (invalidation graph, consent row).
   - Replica model artefacts under `derived/{org}/voices/{speakerId}/` are deleted; embeddings
     column nulled.
   - TargetJobs in flight move to NEEDS_REVIEW with a `consent_revoked` QCIssue; PACKAGING is blocked.
   - Organization Admins are notified with the list of affected jobs and deliverables.
2. Verify the cascade finished: `pnpm polycast consent impact <id>` must show zero live artefacts.
   If any remain (alarm case), delete them manually with the deletion role and record the object
   keys in the ticket, then `pnpm polycast consent cascade-retry <id>`.
3. Deliverables already packaged remain in the bucket by default (they are the org's property and
   may have shipped). If the revocation demands removal, open a takedown case with reason
   `no_consent`; the takedown flow deletes deliverables and revokes signed-URL minting.
4. Reply to the requester within 72 h with what was removed and the fact that copies already
   downloaded by the organization are outside our control; support owns this message.

## Rollback

Revocation is not reversible. A new ConsentRecord must be created and verified if the subject
consents again; nothing from the previous record is reused (new replica model, new renders).
Invalidated renders are not restored. If the revocation was a mistake by an Admin, the org
regenerates affected segments after the new consent is active; cost is on the org.

## Escalation

- Requester claims their voice was used without any consent record: Sev2, privacy lead, open a
  takedown case, preserve audit events for the speaker id, do not delete audit history.
- Cascade fails on more than one job or a deliverable cannot be deleted (object lock legal hold):
  engineering manager and privacy lead; legal hold removal requires Owner-level approval on our
  side and is logged.
