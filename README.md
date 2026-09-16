# Polycast Studio

Multi-tenant podcast localization on AWS. Upload an episode once, confirm speakers and
transcript, choose target languages and voices, and get back publication-ready localized
audio/video with translated captions, preserved production quality, and quality-scored lip
sync for visible speakers. Results are labelled **studio-grade**, never "perfect": every
target ships with measurable QC evidence and a human review path.

> **Status: milestone M1 (first vertical slice, local).** Sign in, upload, validate and analyse,
> choose targets, estimate, submit, watch stages live, review the flagged segment, regenerate,
> approve, and download a checksummed deliverable package, all on docker compose. Every provider
> is still a labelled `Mock*` adapter registered as tier `unavailable`, so localized media is the
> untranslated source and the provenance manifest says so. See
> [docs/implementation-plan.md](docs/implementation-plan.md) for M2 (AWS) and M3 (real providers).

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
cp .env.example .env                      # local/mock defaults; production fails closed without real values
cd services/media-worker && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]" && cd ../..
pnpm build                                # also emits packages/contracts/schema/*.json
pnpm dev                                  # docker compose (Postgres, MinIO) + api :4000 + web :3000 + media worker
```

`pnpm dev` is the one-command bring-up: the API migrates the database on boot, the worker polls
the API's internal task endpoints, and the web app proxies `/api/v1/*` to the API. Sign in at
http://localhost:3000/login (local dev sign-in; never enabled in production), create an
organization, and start a localization. Individual services: `pnpm --filter @polycast/api dev`
(Swagger UI at http://127.0.0.1:4000/docs), `pnpm --filter @polycast/web dev`,
`pnpm --filter @polycast/media-worker dev`.

Storage defaults to the `local` driver (files under `.polycast-data/storage`, URLs signed by the
API). Set `STORAGE_DRIVER=s3` with the MinIO values from `.env.example` to exercise the S3 path;
the worker must use the same driver and location.

### Web app

The web app never exposes the API token to the browser: `/login` (dev sign-in, non-production
only) stores it in an httpOnly cookie, and `app/api/[...path]/route.ts` proxies `/api/v1/*`
to `API_BASE_URL` (default `http://127.0.0.1:4000`) with the bearer header, streaming SSE
through. Only upload part bytes go straight from the browser to signed storage URLs.
`pnpm --filter @polycast/web test` runs the vitest suite (upload client, time formatting,
SSE parsing, stage timeline).

## Verify

```bash
pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm synth
cd services/media-worker && ruff check . && mypy polycast_worker && pytest
pnpm e2e                                  # Playwright + axe over the whole slice (needs Postgres, the worker venv, Chromium)
```

`pnpm test` needs Postgres on `DATABASE_URL` for the API suite (tenant isolation and row-level
security, idempotency, SSE, log redaction, the orchestrator driven by a simulated worker, and an
integration test that runs the real Python worker). CI runs exactly this
(`.github/workflows/ci.yml`) on Node 22 with a Postgres service and Python 3.11 + 3.12.

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
