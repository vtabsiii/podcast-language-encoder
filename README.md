# Podcast Language Encoder

Serverless AWS pipeline that takes a podcast episode, transcribes it, translates the
transcript into other languages, and re-voices each translation as a new audio file.

```
upload  s3://<input-bucket>/episodes/<episode>.mp3
   │
   ▼  EventBridge "Object Created"
Step Functions state machine
   ├─ Amazon Transcribe   StartTranscriptionJob (auto language identification), poll until done
   ├─ Lambda              read transcript → Amazon Translate per target language
   │                      → write transcript.txt → start Amazon Polly synthesis tasks
   └─ poll Polly          until every audio file is written
   │
   ▼
s3://<output-bucket>/<episode>/
   ├─ manifest.json
   ├─ <source-lang>/transcript.txt
   └─ <lang>/transcript.txt, audio-part001-<task>.mp3, ...
```

Everything is defined with the [AWS CDK](https://docs.aws.amazon.com/cdk/) in TypeScript.
Nothing is clicked together in the console; the console is only used once to bootstrap
the account (see [docs/aws-setup.md](docs/aws-setup.md)).

## Repository layout

| Path | What it is |
| --- | --- |
| `bin/podcast-language-encoder.ts` | CDK app entry point, instantiates both stacks |
| `lib/podcast-language-encoder-stack.ts` | The pipeline: buckets, Step Functions, Lambda, EventBridge rule |
| `lib/github-oidc-stack.ts` | One-time stack: GitHub Actions OIDC provider + deploy role |
| `lambda/process-transcript/` | Lambda that translates the transcript and starts Polly tasks |
| `test/` | Jest tests: CDK assertions + Lambda unit tests |
| `.github/workflows/ci.yml` | Build, test, `cdk synth` on every PR |
| `.github/workflows/deploy.yml` | `cdk deploy` on push to `main`, authenticated with OIDC |
| `docs/aws-setup.md` | Step-by-step AWS account bootstrap (console + CloudShell) |
| `CLAUDE.md` | Notes for Claude Code sessions working in this repo |

## Quick start (local)

```bash
npm install
npm run build
npm test
npx cdk synth          # no AWS credentials needed
```

With AWS credentials configured (`aws configure`, SSO, or env vars):

```bash
npx cdk bootstrap                       # once per account/region
npm run deploy:oidc                     # once; prints AWS_DEPLOY_ROLE_ARN for GitHub
npm run deploy                          # the pipeline
```

Then upload an episode and watch the state machine run:

```bash
aws s3 cp my-episode.mp3 s3://<InputBucketName>/episodes/my-episode.mp3
aws stepfunctions list-executions --state-machine-arn <StateMachineArn>
aws s3 ls s3://<OutputBucketName>/my-episode/ --recursive
```

Episode filenames must only contain letters, digits, `.`, `_` and `-` (they become the
Transcribe job name). The part before the first `.` becomes the output folder name.

## Configuration

Set in `cdk.json` `context`, or override on the command line with `-c key=value`:

| Key | Default | Purpose |
| --- | --- | --- |
| `targetLanguages` | `es,fr,de,pt` | ISO 639-1 codes to translate and re-voice into. The detected source language is skipped. |
| `githubOwner` / `githubRepo` | `vtabsiii` / `podcast-language-encoder` | Repository the OIDC deploy role trusts |
| `githubOidcProviderArn` | unset | Reuse an existing GitHub OIDC provider in the account instead of creating one |

Supported target languages (voice map in `lambda/process-transcript/index.ts`):
en, es, fr, de, pt, it, ja, ko, zh, hi, ar, nl, pl, sv, tr.

## GitHub → AWS wiring

The `Deploy` workflow assumes an IAM role via GitHub OIDC. No AWS keys are stored in
GitHub. Required repository settings (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `DeployRoleArn` output of the `PodcastLanguageEncoderGithubOidc` stack |
| `AWS_REGION` | Region you bootstrapped, e.g. `us-east-1` |

The workflow uses the `production` environment; create it under Settings → Environments
(optionally with required reviewers) so deploys can be gated.

## Cost notes

The pipeline is pay-per-use: Transcribe, Translate and Polly are billed per minute / per
character. A one-hour episode into four languages is roughly one hour of Transcribe,
about 40k characters × 4 of Translate, and about 40k characters × 4 of neural Polly.
Buckets are retained on `cdk destroy` so you never lose episodes by accident.
