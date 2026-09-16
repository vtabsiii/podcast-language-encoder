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

## Polycast stacks (M2, manual deploy only)

The seven `Polycast*` stacks in `infra/lib/polycast-*.ts` are synthesized and tested in CI
(`pnpm synth`, `pnpm --filter @polycast/infra test`) but are **never deployed by
`deploy.yml`**. They create paid resources and are deployed only by a person running the
`Deploy Polycast (manual)` workflow (`.github/workflows/deploy-polycast.yml`) with the
`confirm` input set to `deploy-polycast`, or from a laptop/CloudShell with
`npx cdk deploy 'Polycast*'`. Design notes are in `docs/adr/0006-m2-aws-topology.md`.

### What gets created

| Stack | Resources |
| --- | --- |
| `PolycastNetwork` | VPC 10.40.0.0/16, 2 AZs, public + private subnets, 1 NAT gateway, S3 gateway endpoint, interface endpoints (ECR api/dkr, Logs, Secrets Manager, STS, SQS, Step Functions), flow logs (30 d) |
| `PolycastStorage` | KMS key `alias/polycast-media` (rotating) and buckets `polycast-quarantine-<acct>-<region>` (1 d, CORS), `polycast-source-...` (versioned, object lock governance 30 d), `polycast-derived-...` (90 d), `polycast-deliverables-...` (versioned). All RETAIN, private, TLS-only |
| `PolycastData` | Aurora PostgreSQL 16 Serverless v2 (0.5–4 ACU), db `polycast`, owner secret rotated every 30 d, `polycast_app` secret, `rds.force_ssl=1`, 35 d PITR, deletion protection, capacity/connection alarms |
| `PolycastAuth` | Cognito user pool `polycast` (invite only, email sign-in, TOTP optional), custom attributes `org_ids` and `role`, pre-token-generation Lambda, web client (SRP, 1 h access / 30 d refresh), hosted UI domain |
| `PolycastApi` | ECS cluster `polycast`, ECR `polycast/api`, Fargate service `polycast-api` (2–6 tasks) behind an **internal** ALB (`/healthz`, 300 s idle timeout), generated `WORKER_TOKEN` / `LOCAL_JWT_SECRET`, migration task definition `polycast-migrate`, 5xx/unhealthy/p95 alarms |
| `PolycastOrchestration` | EventBridge bus `polycast-events`, SQS `polycast-stage` (+ DLQ, 3 receives) and `polycast-review-wait`, state machines `polycast-localization-job` and `polycast-target-job`, ECR `polycast/media-worker`, Fargate service `polycast-media-worker` (1–4 tasks on queue depth), alarms, SNS alerts topic, monthly budget |
| `PolycastWeb` | ECR `polycast/web`, Fargate service `polycast-web` (2–6 tasks) behind a public ALB that only CloudFront can use, static assets bucket, CloudFront distribution with security headers, optional signed `/media/*` behaviour |

Rough idle cost (us-east-1, no traffic): NAT gateway ~$33/month, seven interface endpoints
~$51/month, five Fargate tasks (2 API, 2 web, 1 worker at 0.5–1 vCPU) ~$60/month, Aurora at
0.5 ACU ~$45/month, ALBs ~$35/month, KMS/secrets/logs/CloudFront a few dollars. Expect
**$220–260/month idle**; the default budget of USD 200 (context `polycastMonthlyBudgetUsd`)
warns at 80% and 100%. Subscribe an email address to the `AlertsTopicArn` output to receive
the notifications. Scale to zero is not possible with this topology; tear down when idle.

### Context keys

Pass with `-c key=value` (or `cdk.json` context); all are optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `polycastWebOrigins` | `http://localhost:3000` | comma-separated browser origins: quarantine CORS, API `CORS_ORIGINS`, Cognito callback URLs. Set to `https://<distribution>.cloudfront.net` after the first deploy and redeploy |
| `polycastImageTag` | `latest` | tag of the three ECR images the services run |
| `polycastCognitoDomainPrefix` | `polycast-<account id>` | hosted UI domain prefix (globally unique per region) |
| `polycastMonthlyBudgetUsd` | `200` | monthly cost budget |
| `polycastCloudFrontPublicKeyPem` | unset | RSA public key; enables the signed `/media/*` behaviour |

### Deploying the first time

1. Bootstrap and the OIDC stack are the same as steps 1–3 above; the GitHub role already
   deploys through the CDK bootstrap roles, so no policy widening is needed.
2. Deploy the stacks once so the ECR repositories exist (the Fargate services will stay
   unhealthy until images are pushed; that is expected):

   ```bash
   cd infra && npx cdk deploy 'Polycast*' --require-approval never
   ```

   or run the manual workflow with `confirm = deploy-polycast`.
3. Build and push the three images from the repository root (Docker with BuildKit):

   ```bash
   ACCOUNT=559315537226 REGION=us-east-1 TAG=$(git rev-parse --short HEAD)
   aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
   for svc in api web media-worker; do
     case $svc in api) f=apps/api/Dockerfile;; web) f=apps/web/Dockerfile;; media-worker) f=services/media-worker/Dockerfile;; esac
     docker build --platform linux/amd64 -f $f -t $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/polycast/$svc:$TAG .
     docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/polycast/$svc:$TAG
   done
   ```

   Then redeploy with `-c polycastImageTag=$TAG` (workflow input `imageTag`). Tags are
   mutable, so pushing `latest` and forcing a new deployment also works for dev.
4. Run the migration task before the API starts serving (repeat before every deploy that
   ships a migration). Values come from the `PolycastApi` and `PolycastNetwork` outputs:

   ```bash
   aws ecs run-task --cluster polycast --launch-type FARGATE \
     --task-definition <MigrateTaskDefinitionArn> \
     --network-configuration "awsvpcConfiguration={subnets=[<PrivateSubnetIds>],securityGroups=[<MigrateSecurityGroupId>],assignPublicIp=DISABLED}"
   aws logs tail /aws/ecs/... --follow   # stream prefix "migrate" in the PolycastApi ApiLogs group
   ```

   The task runs `node dist/db/migrate-cli.js` with the owner credentials and receives
   `DB_APP_PASSWORD` from the app secret so the `polycast_app` role can be created or
   realigned. In production the API does not migrate on boot.
5. Set `polycastWebOrigins` to the CloudFront domain (`DistributionDomainName` output) and
   redeploy so CORS and the Cognito callback URLs match.

### Users and organizations

Users are created by an administrator (self sign-up is off). The API provisions the matching
`users` row just in time: the first request that carries a valid ID token for an unseen `sub`
creates it from the token's `email` and `name` claims. Membership lives in the database, not in
Cognito. A user who signs in with no membership yet is shown the "create your organization"
step on the web sign-in page, which calls `POST /api/v1/organizations`; the caller becomes that
organization's `owner` and every membership-scoped route works from the next request on.
Until then such a user gets `403 FORBIDDEN` (`No organization membership`) from every
tenant-scoped route, including `GET /api/v1/me`.

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username producer@example.com \
  --user-attributes Name=email,Value=producer@example.com Name=email_verified,Value=true Name=name,Value="Producer" \
  --desired-delivery-mediums EMAIL
```

The `custom:org_ids` attribute (space-separated organization ids) and `custom:role` are now
optional. The pre-token trigger still copies them into the `org_ids` (JSON array) and `role`
claims, but the API only uses `org_ids` to pick the default organization for a request that
sends no `X-Organization-Id`; an id the user is not actually a member of is ignored and the
oldest membership is used instead. The `role` claim is never used for authorization.

```bash
# Optional: make <orgId1> the default organization for a user who belongs to several.
aws cognito-idp admin-update-user-attributes --user-pool-id <UserPoolId> --username producer@example.com \
  --user-attributes "Name=custom:org_ids,Value=<orgId1> <orgId2>"
```

The trigger customises the **ID token** (Cognito V1 trigger); the web tier sends the ID token
as the bearer to the API, and the ID token is what carries `email` and `name` for provisioning.
Changing an attribute takes effect at the next token refresh.

### CloudFront signed media and the key group

`/media/*` serves objects from the derived bucket through an origin access control and is only
created when a public key is supplied:

```bash
openssl genrsa -out cloudfront-private.pem 2048          # keep out of git (*.pem is ignored)
openssl rsa -in cloudfront-private.pem -pubout -out cloudfront-public.pem
npx cdk deploy PolycastWeb -c polycastCloudFrontPublicKeyPem="$(cat cloudfront-public.pem)"
```

The `MediaPublicKeyId` output is the key pair id; store the private key in Secrets Manager for
the API, which mints URLs valid for at most 15 minutes (NFR-001). Rotate by adding a second key
to the key group, switching the API to the new key pair id, then removing the old key. Direct
S3 access is never granted to browsers; `PolycastStorage` allows only CloudFront distributions
of this account to read the derived bucket and use the key.

### Teardown

Order matters because of cross-stack references, and buckets, the KMS key, the user pool and
ECR repositories are retained on purpose (they hold user content and identities):

```bash
cd infra
npx cdk destroy PolycastWeb PolycastOrchestration      # services, queues, state machines, budget
npx cdk destroy PolycastApi                            # API service, internal ALB, migrate task
npx cdk destroy PolycastAuth                           # user pool is RETAIN + deletion protection: remove manually if really wanted
npx cdk destroy PolycastData                           # deletion protection must be disabled first; final snapshot is taken
npx cdk destroy PolycastStorage PolycastNetwork        # buckets and key remain; empty/delete them in S3 and schedule key deletion
```

Retained items to clean up by hand when the environment is gone for good: the four media
buckets and the static assets bucket, ECR images, the `alias/polycast-media` key (30-day
pending window), the Cognito user pool, the Aurora final snapshot, and CloudWatch log groups.
