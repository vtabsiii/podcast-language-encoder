# One-time AWS setup

Do this once per AWS account. Everything after this is driven from GitHub Actions or
`npx cdk deploy`; the console is not needed for day-to-day work.

You can do all of it from **AWS CloudShell** in the console (no local AWS CLI needed).

## 1. Pick the account and region

1. Sign in to the [AWS console](https://console.aws.amazon.com/).
2. Choose a region in the top-right (for example `us-east-1`). All of Transcribe,
   Translate, Polly, Step Functions and Lambda must be available there; the default
   US and EU regions are fine.
3. Note the 12-digit account ID (top-right account menu).

Recommended: create a dedicated account in AWS Organizations for this project, or at least
a dedicated IAM Identity Center user with `AdministratorAccess` for the bootstrap steps
below. Do not use the root user.

## 2. Bootstrap CDK and deploy the GitHub trust

Open **CloudShell** (terminal icon in the console header) and run:

```bash
git clone https://github.com/vtabsiii/podcast-language-encoder.git
cd podcast-language-encoder
npm install

# CDK needs a staging bucket + roles in the account. Once per account/region.
npx cdk bootstrap

# Create the OIDC provider and the role GitHub Actions will assume.
npm run deploy:oidc
```

The last command prints:

```
Outputs:
PodcastLanguageEncoderGithubOidc.DeployRoleArn = arn:aws:iam::123456789012:role/podcast-language-encoder-github-deploy
```

If the account already has a GitHub OIDC provider (`token.actions.githubusercontent.com`),
the deploy fails with "Provider already exists". Find its ARN under
IAM → Identity providers and re-run with it:

```bash
npx cdk deploy PodcastLanguageEncoderGithubOidc -c githubOidcProviderArn=arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com
```

## 3. Wire GitHub to the role

In the GitHub repo, **Settings → Secrets and variables → Actions → Variables → New repository variable**:

| Name | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` printed above |
| `AWS_REGION` | the region from step 1 |

Then **Settings → Environments → New environment** named `production`. Add required
reviewers if you want a manual approval before each deploy.

## 4. First deploy

Either push to `main` (the `Deploy` workflow runs), or from CloudShell:

```bash
npm run deploy
```

Outputs include `InputBucketName`, `OutputBucketName` and `StateMachineArn`.

## 5. Smoke test

```bash
aws s3 cp sample.mp3 s3://<InputBucketName>/episodes/sample.mp3
```

Watch progress in **Step Functions → State machines → EncoderStateMachine** in the console.
A ten-minute episode takes roughly 5 to 10 minutes end to end. Results appear under
`s3://<OutputBucketName>/sample/`.

## 6. Give Claude Code access (optional)

For a Claude Code session to deploy or inspect the stack directly it needs AWS credentials
in its environment. Prefer short-lived credentials:

- **Local Claude Code**: run `aws sso login` (IAM Identity Center) or `aws configure` on the
  machine; Claude Code inherits the profile via `AWS_PROFILE`.
- **Claude Code on the web**: add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN` and `AWS_REGION` as environment variables on the cloud environment,
  and allow `*.amazonaws.com` in its network policy. Use an IAM user or role scoped to
  this project (at minimum the `cdk-*` assume permissions from
  `lib/github-oidc-stack.ts`, plus read access to the two buckets and Step Functions).

Never commit credentials to the repo; `.gitignore` already excludes `.env*`.

## Teardown

```bash
npx cdk destroy PodcastLanguageEncoder
```

Buckets are retained (`RemovalPolicy.RETAIN`); empty and delete them in S3 if you want a
clean account. The OIDC stack can stay or be destroyed with
`npx cdk destroy PodcastLanguageEncoderGithubOidc`.
