# Runbook: restore database

Aurora PostgreSQL Serverless v2 cluster `polycast-<env>` (M2). Targets: RPO 15 min, RTO 4 h
(NFR-014). Drill quarterly; record the drill in the ops log.

## Symptoms

- Data corruption from a bad migration or application bug (wrong rows deleted/updated).
- Cluster unavailable and not recovering (`aws rds describe-db-clusters` shows `failed` /
  `inaccessible-encryption-credentials`), or a regional event.
- Alarm `Polycast/AuroraWriterUnavailable` or `Polycast/ApiErrorRate5xx` with DB errors.

## Diagnosis

1. Establish the damage window: last known-good time from application logs and the
   `audit_events` table (`SELECT max(occurred_at) FROM audit_events;` if reachable) or from the
   migration timestamp in `schema_migrations`.
2. Check PITR availability:
   `aws rds describe-db-clusters --db-cluster-identifier polycast-<env> --query 'DBClusters[0].[EarliestRestorableTime,LatestRestorableTime]'`.
3. Check cross-region snapshot copies (DR): `aws rds describe-db-cluster-snapshots --region us-west-2 --db-cluster-identifier polycast-<env>`.
4. Decide: partial repair (single table from a restored clone) vs full cluster restore vs
   regional failover. Partial repair is preferred for application bugs; full restore for
   corruption; failover for regional loss.

## Remediation

### Freeze

1. Put the API in maintenance mode: `[planned CLI, M2] pnpm polycast maint on --reason "<text>"`
   (ALB returns 503 with maintenance page; SSE clients reconnect later). Interim: scale the API
   service to 0 tasks: `aws ecs update-service --cluster polycast-control --service polycast-api --desired-count 0`.
2. Pause orchestration: `aws stepfunctions` has no global pause; set SSM
   `/polycast/orchestration/paused = true` so workers park at stage boundaries (they check it
   before writing results). In-flight provider calls continue and their results are queued.

### Restore

3. Point-in-time restore to a new cluster:
   `aws rds restore-db-cluster-to-point-in-time --source-db-cluster-identifier polycast-<env> --db-cluster-identifier polycast-<env>-restore-<ts> --restore-to-time <ISO> --serverless-v2-scaling-configuration MinCapacity=2,MaxCapacity=32 --vpc-security-group-ids <sg> --db-subnet-group-name <subnet-group> --kms-key-id <key>`
   then `aws rds create-db-instance --db-cluster-identifier polycast-<env>-restore-<ts> --db-instance-identifier ... --db-instance-class db.serverless --engine aurora-postgresql`.
4. Validate on the restored cluster (read-only session): row counts for `organizations`,
   `projects`, `target_jobs`; `schema_migrations` head matches the deployed API version; spot-check
   the damage window.
5. Partial repair path: copy the affected tables from the restored cluster into the live cluster
   with `pg_dump -t <table> | psql`, reconciling by `id` (UUIDv7 makes ordering by time easy).
   Full restore path: update the API's secret/endpoint (CDK parameter `DbClusterIdentifier`)
   via `cdk deploy PolycastData` targeting the restored cluster, or rename clusters
   (`aws rds modify-db-cluster --new-db-cluster-identifier`).

### Reconcile

6. Replay deletions: `pnpm polycast deletion replay --since <restore-time>` re-applies every
   DeletionRequest recorded after the restore point (the requests table is also restored, so
   this uses the S3-archived copy of `deletion_requests` written by the deletion worker).
7. Reconcile orchestration: for every TargetJob whose Step Functions execution advanced past the
   restored DB state, `pnpm polycast job reconcile` reads execution history and replays stage
   results into the DB (stage outputs are in S3 and idempotent).
8. Reconcile the outbox: events between restore point and freeze may have been published already;
   consumers are idempotent by event id, so republishing is safe. `pnpm polycast events republish --since <restore-time>`.
9. Unfreeze: clear the SSM pause, scale the API back, `pnpm polycast maint off`. Watch
   `Polycast/ApiErrorRate5xx` and DLQ depth for 30 minutes.

### Regional loss

Restore from the latest cross-region snapshot in us-west-2, deploy the `PolycastData` and
`PolycastApi` stacks there with `cdk deploy --context region=us-west-2` (M2 makes the stacks
region-parametric), then follow Reconcile. S3 buckets have cross-region replication for source
and deliverables (M2); derived artefacts are regenerated.

## Rollback

The original cluster is never deleted during the procedure; keep it (renamed
`polycast-<env>-broken-<ts>`) for 7 days. If the restored cluster proves worse, switch the
endpoint back and re-run Reconcile from the original. Migrations that caused the incident are
reverted with the `down` script and a new forward migration, never by editing history.

## Escalation

- RTO at risk (2 h elapsed without a validated restored cluster): engineering manager, customer
  comms via status page.
- Suspected malicious deletion or tampering: security lead; preserve the broken cluster and
  CloudTrail; do not overwrite anything.
- Restore point predates a completed deletion request that cannot be replayed automatically:
  privacy lead, complete the deletion manually (`deletion-request.md`) before unfreezing.
