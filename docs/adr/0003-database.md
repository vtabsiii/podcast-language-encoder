# ADR-0003: Database

Status: Accepted

## Context

The control plane stores tenant metadata, transcripts (segments and words, potentially millions of
rows per organization), job state, QC results, audit and cost ledgers. Needs: strong tenant
isolation, transactions across job state and outbox events, JSON for provider payloads, PITR with
RPO ≤ 15 min, scale-to-low-cost in dev, identical behaviour locally. Options: Aurora PostgreSQL
Serverless v2, RDS PostgreSQL provisioned, DynamoDB single-table, a mix (DynamoDB for job state,
Postgres for the rest).

## Decision

Aurora PostgreSQL Serverless v2 (PostgreSQL 16 compatible) in AWS; PostgreSQL 16 via docker
compose locally. One database, one schema, every table with `organization_id uuid not null` and
row-level security policies keyed on `current_setting('app.org_id', true)`. The API sets the
setting per transaction from the verified token; a superuser-less application role means RLS
cannot be bypassed by application code. Migrations are plain SQL managed by a migration tool run
from CI (`pnpm db:migrate`), applied identically locally and in AWS. IDs are UUIDv7 generated in
the API. Media time columns are `bigint` microseconds. Outbox table for events; LISTEN/NOTIFY for
SSE fan-out in v1 (no Redis, assumption A-11).

Backups: continuous PITR (35 days) plus daily snapshots copied to a second region for DR; that
satisfies RPO 15 min / RTO 4 h with the restore runbook.

## Consequences

- Positive: relational integrity for the entity graph (`architecture.md` §9); RLS as a second
  isolation layer that the tenant-isolation tests exercise; serverless scaling from 0.5 ACU in dev
  to tens of ACUs in production; no local/production divergence.
- Negative: Word rows are the largest table; partitioning by `organization_id` hash and archiving
  words for completed projects to S3 (Parquet) is planned once size warrants. Serverless v2 has a
  minimum cost floor and scale-up latency of seconds; ACU alarms are in M2. LISTEN/NOTIFY limits
  SSE fan-out to a single database; acceptable for v1 scale (NFR-007).
- Rejected DynamoDB single-table: the review studio queries (segments by time range, issues by
  segment, lineage chains) are relational, and RLS-style isolation would be application-only.
