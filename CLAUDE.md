# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## What this is

Polycast Studio: a multi-tenant podcast localization platform on AWS (upload → analyze →
translate → re-voice → lip-sync → QC → package). `docs/product-spec.md` is the controlling
spec; `docs/implementation-plan.md` tracks milestones. The original serverless encoder
(S3 → Step Functions → Transcribe → Lambda(Translate + Polly) → S3) lives on in `infra/` as
the "legacy encoder" stack and is documented in `docs/aws-setup.md`.

## Layout (pnpm workspaces + Turborepo)

- `apps/web` Next.js App Router (TS strict). `apps/api` Fastify + Zod + OpenAPI at `/api/v1`.
- `packages/domain` entities, job state machine, capability registry, time base, roles, errors.
- `packages/contracts` Zod schemas; `pnpm build` emits JSON Schema into `schema/` for Python.
- `packages/ui` tokens + accessible primitives. `services/media-worker` Python worker.
- `infra` AWS CDK (TypeScript). Stack ids: `PodcastLanguageEncoder`, `PodcastLanguageEncoderGithubOidc`.

## Commands

```bash
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test   # all Node packages
pnpm synth                                                # CDK synth, no AWS credentials needed
pnpm --filter @polycast/api dev                           # API on :4000 (/docs for Swagger UI)
pnpm --filter @polycast/web dev                           # web on :3000
docker compose up -d                                      # local Postgres + MinIO
cd services/media-worker && pip install -e ".[dev]" && ruff check . && mypy polycast_worker && pytest
```

Run the full Node chain plus the Python chain before committing.

## Rules that must hold

- Media time is integer microseconds (`Microseconds` brand / `Microseconds = int`). Never float seconds as truth.
- State transitions go through `packages/domain` `transition()`; nothing else decides legality.
- Language availability comes from the capability registry. Never hard-code locales in UI.
  No seed locale is `production`; promotion happens only via `docs/quality-benchmark.md`.
- Every provider is behind an adapter interface. Mock adapters are named `Mock*` and register
  as tier `unavailable`. Production config fails closed (`apps/api/src/config.ts`, `services/media-worker/polycast_worker/config.py`).
- Tenant scope comes from the authenticated principal, never from request bodies.
- Never log transcripts, media, signed URLs, biometric data, tokens, or secrets.
- Infrastructure only via CDK. S3 buckets keep `RemovalPolicy.RETAIN`.
- GitHub Actions authenticate to AWS with OIDC only. Never add AWS keys as secrets.
- Do not commit `cdk.out/`, `cdk.context.json`, `.env*`, media files, or model weights.

## AWS access from a session

`pnpm synth` and all tests need no credentials. Deploying does; see `docs/aws-setup.md`.
Dev deploys target account 559315537226 / us-east-1 (see `docs/assumptions.md`).
If `aws sts get-caller-identity` fails, stop and report rather than retrying deploys.
