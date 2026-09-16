# Runbooks

Operational procedures for Polycast Studio. Nothing here is deployed yet; commands marked
`[planned CLI]` refer to `pnpm polycast …` subcommands that do not exist until the milestone noted.
AWS CLI commands assume the dev account (559315537226, us-east-1) and a session obtained via the
GitHub OIDC role or an operator SSO role; never long-lived keys.

| Runbook | Use when | Severity guidance |
|---|---|---|
| [stuck-job.md](stuck-job.md) | A TargetJob has not changed stage for longer than its stage SLO | Sev3; Sev2 if > 10 jobs or a production-tier locale |
| [provider-outage.md](provider-outage.md) | A provider returns errors/timeouts across jobs, or announces an incident | Sev2; Sev1 if all TTS or transcription is down |
| [consent-revocation.md](consent-revocation.md) | A speaker revokes consent or a consent record is found invalid | Sev2 (legal exposure); handle same day |
| [deletion-request.md](deletion-request.md) | Data deletion request from a customer or data subject | Sev3 with a 30-day clock; embeddings same day |
| [restore-database.md](restore-database.md) | Aurora data loss/corruption, failed migration, region event | Sev1; RTO 4 h, RPO 15 min |

## Conventions

- Every runbook has: Symptoms, Diagnosis, Remediation, Rollback, Escalation.
- Never paste transcripts, media URLs or signed URLs into tickets or chat; reference ids only.
- Record every manual action as an audit event (`[planned CLI] pnpm polycast audit note --job <id> --text "..."`) until the CLI exists, in the incident ticket.
- Escalation chain: on-call engineer → media-plane lead → engineering manager → Owner of the affected organization (customer comms are done by support, not engineers).
- Alarm names are prefixed `Polycast/` in CloudWatch (M2).
