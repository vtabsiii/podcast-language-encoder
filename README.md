# Polycast Studio

Multi-tenant podcast localization on AWS. Upload an episode once, confirm speakers and
transcript, choose target languages and voices, and get back publication-ready localized
audio/video with translated captions, preserved production quality, and quality-scored lip
sync for visible speakers. Results are labelled **studio-grade**, never "perfect": every
target ships with measurable QC evidence and a human review path.

> **Status: milestone M0 (scaffold).** The monorepo, domain model, contracts, API skeleton,
> web shell, worker skeleton, CDK, CI, and documentation are in place. No provider does real
> work yet; every adapter is a labelled `Mock*` registered as tier `unavailable`. See
> [docs/implementation-plan.md](docs/implementation-plan.md) for what comes next.

The original serverless encoder (S3 → Step Functions → Transcribe → Lambda(Translate +
Polly) → S3) is retained in `infra/` as the **legacy encoder** stack and still deploys on
push to `main`. Its setup guide is [docs/aws-setup.md](docs/aws-setup.md).

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 10 (`corepack enable` or `npm i -g pnpm`)
- Python 3.11+ (3.12 targeted) for `services/media-worker`
- Docker (for local Postgres + MinIO via `docker-compose.yml`)
- `ffprobe`/`ffmpeg` for real media probing (unit tests run without it)
- AWS credentials only for `cdk deploy`; everything else works offline

## Layout

| Path                    | What                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `apps/web`              | Next.js App Router UI (dashboard, wizard, processing, review studio, deliverables)      |
| `apps/api`              | Fastify + Zod + OpenAPI control-plane API at `/api/v1` (Swagger UI at `/docs`)          |
| `packages/domain`       | Entities, job state machine, capability registry, µs time base, roles, errors, UUID v7 |
| `packages/contracts`    | Zod schemas for API/events/worker messages; emits JSON Schema to `schema/` for Python  |
| `packages/ui`           | Design tokens and accessible primitives                                                |
| `services/media-worker` | Python worker: probe/validate, proxy, mix, encode, QC, package; provider Protocols      |
| `infra`                 | AWS CDK stacks (legacy encoder today; Polycast stacks arrive in M2)                    |
| `docs`                  | Spec, plan, architecture, threat model, privacy, benchmark, ADRs, runbooks, traceability |

## Architecture in one paragraph

A **control plane** (web, API, Aurora PostgreSQL, Cognito, Step Functions, EventBridge/SQS)
owns tenants, projects, jobs, reviews, and billing. A **media plane** (private S3, Fargate
CPU workers, Batch GPU workers, MediaConvert/FFmpeg) does the work. A parent workflow
analyzes the source once, then fans out an immutable **TargetJob** per locale. Every
provider (transcription, translation, speech, lip sync, encode, quality) sits behind an
adapter and is selectable only at the tier the **capability registry** records for that
locale/region. Details: [docs/architecture.md](docs/architecture.md).

## Run locally

```bash
pnpm install
docker compose up -d                      # Postgres :5432, MinIO :9000/:9001
cp .env.example .env
pnpm build                                # also emits packages/contracts/schema/*.json
pnpm --filter @polycast/api dev           # http://127.0.0.1:4000/docs
pnpm --filter @polycast/web dev           # http://localhost:3000
```

Python worker:

```bash
cd services/media-worker
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

## Verify

```bash
pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm synth
cd services/media-worker && ruff check . && mypy polycast_worker && pytest
```

CI runs exactly this (`.github/workflows/ci.yml`) on Node 22 and Python 3.11 + 3.12.

## Deploy

Deploys go through GitHub Actions with a short-lived OIDC role; no AWS keys are stored.
`Deploy` runs on push to `main` and currently deploys only the legacy encoder stack. The dev
account is `559315537226` / `us-east-1` ([docs/assumptions.md](docs/assumptions.md)).
Polycast stacks are added in milestone M2.

## Key documents

- [docs/product-spec.md](docs/product-spec.md): controlling requirements (FR/NFR ids)
- [docs/implementation-plan.md](docs/implementation-plan.md): milestones and definition of done
- [docs/architecture.md](docs/architecture.md): C4 diagrams, state machine, ER, events, invalidation
- [docs/threat-model.md](docs/threat-model.md), [docs/privacy-and-consent.md](docs/privacy-and-consent.md)
- [docs/quality-benchmark.md](docs/quality-benchmark.md): how a language earns Production
- [docs/adr/](docs/adr/), [docs/runbooks/](docs/runbooks/), [docs/traceability.md](docs/traceability.md)
