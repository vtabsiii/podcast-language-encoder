# ADR-0006: M2 AWS topology

Status: Accepted (M2; stacks are written and synthesized, deployed only by hand)

## Context

M2 moves the M1 vertical slice into account 559315537226 / us-east-1 on CDK-managed
infrastructure (implementation-plan.md). The pieces were decided earlier: CloudFront + Fargate
for the web tier (ADR-0001), Fastify on Fargate (ADR-0002), Aurora PostgreSQL Serverless v2
(ADR-0003), parent/child Step Functions with task tokens (ADR-0004). What remained open was how
the pieces are exposed to each other and to the internet, how the images reach ECS, how much
the idle environment may cost, and who is allowed to deploy it. The seven stacks live in
`infra/lib/polycast-*.ts`; ids are `PolycastNetwork`, `PolycastStorage`, `PolycastData`,
`PolycastAuth`, `PolycastApi`, `PolycastOrchestration`, `PolycastWeb`.

## Decisions

1. **Internal API ALB; CloudFront-only web ALB.** `apps/api` sits behind an application load
   balancer with `internetFacing: false` in the private subnets. Its security group admits only
   the web service and the media-worker service (rules added by the depending stacks with
   `remoteRule = true`, so no stack cycle). `/internal/v1` is therefore unreachable from the
   internet without any listener rule; `test/polycast-api.test.ts` asserts the scheme and that no
   `0.0.0.0/0` ingress exists. `apps/web` sits behind a public ALB whose default action is 403; a
   single listener rule forwards requests carrying the `X-Origin-Verify` header with a generated
   Secrets Manager value that CloudFront attaches as an origin custom header. Browsers only ever
   talk to CloudFront; `/api/*` reaches the API through the Next.js proxy route. Rejected: a
   public API ALB with a 403 rule for `/internal/*` (one more public surface for no benefit) and
   API Gateway in front of the ALB (SSE and idle-timeout semantics are worse).
2. **No custom domain or certificate in M2.** The distribution uses its `*.cloudfront.net` name
   and reaches the web ALB over HTTP on port 80; viewers are HTTPS-only. An ACM certificate and
   Route 53 zone arrive with the first real domain, at which point the origin protocol becomes
   HTTPS and the ALB security group can be narrowed to the CloudFront origin-facing prefix list.
3. **One NAT gateway, two AZs.** Dev cost over availability; the private subnets keep
   interface endpoints for ECR, CloudWatch Logs, Secrets Manager, STS, SQS and Step Functions
   plus an S3 gateway endpoint so steady-state traffic does not cross the NAT. Production raises
   `natGateways` to one per AZ.
4. **Aurora Serverless v2 at 0.5 to 4 ACU.** Enough for the slice and the tenant-isolation
   tests; `PolycastData` exposes the range as props. `rds.force_ssl=1`, 35-day PITR, deletion
   protection, snapshot on delete, owner secret rotated every 30 days, a second secret for the
   `polycast_app` role that the migration realigns from `DB_APP_PASSWORD`. Credentials reach ECS
   as individual fields (`DB_HOST`, `DB_OWNER_USER`, ...) via `ecs.Secret.fromSecretsManager`,
   never as a URL, so no task definition carries a password.
5. **Images by ECR tag, not CDK asset bundling.** The three ECR repositories (`polycast/api`,
   `polycast/web`, `polycast/media-worker`) are created by the stacks; services run
   `ContainerImage.fromEcrRepository(repo, imageTag)` with the tag from context
   (`polycastImageTag`). Building the images inside `cdk deploy` would make synth depend on
   Docker and slow every CI run; images are built and pushed explicitly (docs/aws-setup.md).
   Dockerfiles live next to each app and are not built in CI yet.
6. **Task-token Step Functions with SQS.** The child state machine is generated from
   `infra/lib/stage-table.ts` (a copy of the API's `TARGET_STAGE_ORDER`, kept in sync by a text
   test); each stage is `SqsSendMessage` with `.waitForTaskToken`, retry 30 s x2 up to 3 attempts,
   catch to `<STAGE>_FAILED`. LIP_SYNCING is skipped on `$.lipSync == false`; after TARGET_QA a
   ReadyGate inserts NEEDS_REVIEW as a task-token wait on a separate review-wait queue with a
   365-day timeout. The parent machine is Pass states for TRANSCRIBING / SOURCE_QA (analysis
   already ran) and a Map with `MaxConcurrencyPath` from the organization quota. The M1 worker
   still polls the API; the SQS queue is the seam the API's `StepFunctionsOrchestrator` bridges.
   The API grants itself `states:*` on state machines named `polycast-*` and `events:PutEvents`
   on the `polycast-events` bus by name, so `PolycastApi` does not depend on
   `PolycastOrchestration`, which depends on the API for the worker token and internal URL.
7. **Manual-only deploy.** By the owner's decision the Polycast stacks are not in
   `deploy.yml`. `deploy-polycast.yml` runs only on `workflow_dispatch` with a `confirm` input
   that must equal `deploy-polycast`, uses the existing GitHub OIDC role (CDK deploys through the
   bootstrap roles, so no widening was needed) and deploys `Polycast*` after tests and a diff.
8. **Cost guardrails.** Every stack tags resources with `project`, `service`,
   `polycast:service` and `polycast:stack`; `PolycastOrchestration` creates an AWS Budgets
   monthly cost budget (default USD 200, context `polycastMonthlyBudgetUsd`) notifying an SNS
   topic at 80% and 100%, and alarms for DLQ depth, failed executions, review-wait age, API 5xx
   rate, unhealthy hosts, p95 latency and Aurora capacity.

## Consequences

- Positive: one private path into the API, no secrets in task definitions, environment-agnostic
  stacks that synth and test without credentials, deterministic names for the buckets, queues
  and state machines that the API can address without cross-stack imports, and a deploy that
  cannot happen by accident.
- Negative: CloudFront-to-ALB traffic is plain HTTP until a certificate exists; a single NAT is
  a single point of failure for egress; the first deploy needs three manual image pushes before
  the services become healthy; the `/media/*` behaviour is only created when a signing public key
  is supplied through context; Cognito's pre-token trigger (V1) customises the ID token only, so
  the web tier sends the ID token to the API.
- Follow-ups: ACM + Route 53 (ADR-0001 revisit), CloudFront prefix-list ingress on the web ALB,
  a reader instance and `natGateways: 2` before production traffic, key-group rotation runbook,
  building and pushing the images from CI once the deploy is no longer manual.
