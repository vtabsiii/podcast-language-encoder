# Runbook: stuck job

## Symptoms

- Alarm `Polycast/StageLatencyP95` or `Polycast/StuckTargetJobs` fires (M2).
- Processing view shows a TargetJob in the same stage beyond the stage SLO
  (TRANSCRIBING 2× media duration; TRANSLATING 20 min; SYNTHESIZING 30 min; LIP_SYNCING 3× media
  duration; other stages 15 min). NEEDS_REVIEW is a human wait and is not "stuck".
- Customer reports a job "spinning".

## Diagnosis

1. Identify the job and its current stage.
   `[planned CLI, M1] pnpm polycast job show <targetJobId>` (prints stage, attempt, last event, execution ARN).
   Interim: `SELECT id, status, stage_attempt, updated_at FROM target_jobs WHERE id = '<id>';`
2. Is the orchestrator execution alive?
   `aws stepfunctions describe-execution --execution-arn <arn>` (M2). Locally: check the
   `orchestration_queue` table for the job's pending task.
3. Is the worker task running or did it die?
   `aws ecs list-tasks --cluster polycast-media --started-by <targetJobId>` and
   `aws logs filter-log-events --log-group-name /polycast/media-worker --filter-pattern '{ $.targetJobId = "<id>" }'`.
   For GPU stages: `aws batch describe-jobs --jobs <batchJobId>`.
4. Is the message in a DLQ? `aws sqs get-queue-attributes --queue-url <stage-dlq> --attribute-names ApproximateNumberOfMessages`.
5. Is it a provider problem? If several jobs on the same stage/provider are stuck, switch to
   `provider-outage.md`.
6. Check for a task-token wait that never got its callback (stage completed in logs but state
   machine still waiting): compare worker "stage.completed" log line with execution history.

## Remediation

- Worker died, execution alive: the Step Functions retry will re-run the stage on heartbeat
  timeout (default 2× stage SLO). To force it now:
  `[planned CLI, M2] pnpm polycast job retry-stage <targetJobId>` which sends `SendTaskFailure`
  with cause `operator-retry`. Stages are idempotent on (targetJobId, stage, attempt).
- Message in DLQ: inspect the message body (ids only, no content), fix the cause, then redrive:
  `aws sqs start-message-move-task --source-arn <dlq-arn> --destination-arn <queue-arn>`.
- Lost task token: `[planned CLI, M2] pnpm polycast job resume <targetJobId> --from <STAGE>` which
  reads the persisted token from `stage_runs` and calls `SendTaskSuccess` with the stored output.
- Execution itself is gone (deleted, aborted): create a new child execution from the last
  completed stage: `[planned CLI, M2] pnpm polycast job restart <targetJobId> --from <STAGE>`.
- Job cannot be recovered: move to FAILED with a reason so the customer sees it and the cost
  ledger closes: `[planned CLI, M1] pnpm polycast job fail <targetJobId> --reason "<text>"`.

## Rollback

Every remediation above creates a new stage attempt; previous attempt artefacts remain under
`derived/{org}/{targetJob}/{stage}/attempt-N/` until retention. If a forced retry made things
worse, `pnpm polycast job restart --from <earlier STAGE>` re-runs from the last good attempt.
Never edit `target_jobs.status` by hand; use the transition commands so events and audit rows
are emitted.

## Escalation

- More than 10 jobs stuck on one stage, or any production-tier locale affected: page the
  media-plane lead, open a Sev2.
- Suspected data corruption (stage output missing while marked complete): stop retries, escalate
  to engineering manager, preserve the execution history export
  (`aws stepfunctions get-execution-history --execution-arn <arn> > incident-<id>.json`).
