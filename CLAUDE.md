# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## What this is

An AWS CDK (TypeScript) app that deploys a serverless podcast pipeline:
S3 upload → Step Functions → Amazon Transcribe → Lambda (Amazon Translate + Amazon Polly) → S3.
See README.md for the architecture and docs/aws-setup.md for account bootstrap.

## Commands

```bash
npm install            # deps (root package.json also serves the Lambda bundle)
npm run build          # tsc
npm test               # jest: CDK assertions + Lambda unit tests
npx cdk synth          # works without AWS credentials
npx cdk diff / deploy  # needs AWS credentials + a bootstrapped account
```

Run `npm run build && npm test && npx cdk synth` before committing infrastructure changes.

## Layout

- `bin/` CDK app entry; `lib/` stacks; `lambda/process-transcript/` handler bundled by esbuild.
- `lambda/` is excluded from the root `tsconfig.json` build; it is type-checked by ts-jest
  through the tests and bundled by `aws-lambda-nodejs` at synth time.
- Stack ids: `PodcastLanguageEncoder` (app) and `PodcastLanguageEncoderGithubOidc` (one-time).

## Conventions

- Infrastructure only via CDK; do not hand-create resources in the console.
- S3 buckets use `RemovalPolicy.RETAIN`; keep it that way, they hold user content.
- Add a supported language by extending `VOICES` in `lambda/process-transcript/index.ts`
  and `targetLanguages` in `cdk.json`.
- Step Functions definition uses JSONPath + intrinsic functions; keep state input shapes
  documented in the stack comments when changing them.
- GitHub Actions authenticate to AWS with OIDC only. Never add AWS keys as secrets.
- Do not commit `cdk.out/`, `cdk.context.json`, compiled `.js`, or `.env*`.

## AWS access from a session

`npx cdk synth` and tests need no credentials. Deploying does; see docs/aws-setup.md §6.
If `aws sts get-caller-identity` fails, stop and report rather than retrying deploys.
