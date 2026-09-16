# ADR-0004: Workflow orchestration

Status: Accepted

## Context

A LocalizationJob fans out into up to dozens of TargetJobs, each a chain of long-running stages
(minutes to hours), with retries, human-in-the-loop waits (NEEDS_REVIEW can last days), partial
regeneration, cancellation and per-tenant concurrency quotas (FR-050, FR-051, FR-053). The
existing legacy encoder already uses Step Functions. Options: Step Functions Standard, Step
Functions Express, Temporal (self-hosted or cloud), a custom SQS-driven state machine, Airflow.

Local development must run the whole pipeline without AWS (M1).

## Decision

AWS Step Functions Standard workflows: a parent state machine per LocalizationJob and a child
state machine per TargetJob started from a Map state whose concurrency is set from the
organization's quota. Stages are Fargate/Batch tasks or SQS-backed workers invoked with
`.waitForTaskToken`; NEEDS_REVIEW is a task-token wait resolved by the approve endpoint. Stage
definitions come from a single stage table in `packages/domain` from which the CDK definition is
generated, so the state names match the job state machine exactly.

An orchestration port in `packages/domain` has two implementations: `StepFunctionsOrchestrator`
(AWS) and `LocalOrchestrator` (in-process worker loop over a Postgres queue) that executes the same
stage table with the same retry/catch semantics (assumption A-08). Domain code never references
Step Functions types.

## Consequences

- Positive: durable executions up to a year cover review waits; built-in retry, catch, history and
  console visibility; no cluster to run; Map with concurrency gives fan-out and quotas for free;
  aligns with the legacy stack the team already deploys.
- Negative: Step Functions definitions are hard to unit test, hence the generated-from-table
  approach and a synth-time assertion that every job state has a matching state name. Standard
  workflow pricing is per transition; with ~15 transitions per target and 1,000 targets this is
  negligible relative to media compute. Partial regeneration is a separate small execution rather
  than re-entering the child mid-way. The local adapter is a second implementation to keep in sync;
  a contract test runs the same fixture job through both once M2 exists.
- Rejected Express (5-minute limit), Temporal (operational cost and a second control plane for a
  small team; reconsider if workflow complexity outgrows ASL), custom SQS machine (reinventing
  retries and history).
