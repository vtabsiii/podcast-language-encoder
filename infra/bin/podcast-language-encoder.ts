#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PodcastLanguageEncoderStack } from '../lib/podcast-language-encoder-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { PolycastNetworkStack } from '../lib/polycast-network-stack';
import { PolycastStorageStack } from '../lib/polycast-storage-stack';
import { PolycastDataStack } from '../lib/polycast-data-stack';
import { PolycastAuthStack } from '../lib/polycast-auth-stack';
import { PolycastApiStack } from '../lib/polycast-api-stack';
import { PolycastOrchestrationStack } from '../lib/polycast-orchestration-stack';
import { PolycastWebStack } from '../lib/polycast-web-stack';

const app = new cdk.App();

// Account/region come from the credentials in use (CLI, CloudShell, or GitHub Actions).
// Override with CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION or the AWS_* env vars.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const githubOwner = app.node.tryGetContext('githubOwner') ?? 'vtabsiii';
const githubRepo = app.node.tryGetContext('githubRepo') ?? 'podcast-language-encoder';
const targetLanguages: string = app.node.tryGetContext('targetLanguages') ?? 'es,fr,de,pt';

// ------------------------------------------------------------- legacy encoder
// One-time stack: lets GitHub Actions in this repo deploy without long-lived AWS keys.
const oidc = new GithubOidcStack(app, 'PodcastLanguageEncoderGithubOidc', {
  env,
  githubOwner,
  githubRepo,
  description: 'GitHub Actions OIDC provider + deploy role for podcast-language-encoder',
});

// The application itself.
const encoder = new PodcastLanguageEncoderStack(app, 'PodcastLanguageEncoder', {
  env,
  targetLanguages: targetLanguages
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  description: 'Podcast language encoder: transcribe -> translate -> re-voice pipeline',
});

cdk.Tags.of(oidc).add('project', 'podcast-language-encoder');
cdk.Tags.of(encoder).add('project', 'podcast-language-encoder');

// ------------------------------------------------------------ Polycast Studio (M2)
// Synthesized and tested in CI; deployed only by the manual deploy-polycast workflow
// (docs/aws-setup.md "Polycast stacks"). Context keys, all optional:
//   polycastWebOrigins             comma-separated browser origins (CORS, Cognito callbacks)
//   polycastSesFromAddress         verified SES sender for worker email notifications
//   polycastAdminEmail             first Cognito user (invitation email with a temporary password)
//   polycastAdminResend            any new value re-sends that invitation (fresh temporary password)
//   polycastCognitoDomainPrefix    hosted UI prefix (default polycast-<account id>)
//   polycastMonthlyBudgetUsd       AWS Budgets limit (default 200)
//   polycastCloudFrontPublicKeyPem RSA public key enabling the signed /media/* behaviour
const contextString = (key: string): string | undefined => {
  const value = app.node.tryGetContext(key);
  return value === undefined || value === null || value === '' ? undefined : String(value);
};
const polycastWebOrigins = (contextString('polycastWebOrigins') ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const polycastSesFromAddress = contextString('polycastSesFromAddress');
const polycastAdminEmail = contextString('polycastAdminEmail');
const polycastAdminResend = contextString('polycastAdminResend');
const polycastCognitoDomainPrefix =
  contextString('polycastCognitoDomainPrefix') ?? `polycast-${cdk.Aws.ACCOUNT_ID}`;
const polycastMonthlyBudgetUsd = Number(contextString('polycastMonthlyBudgetUsd') ?? 200);
const polycastCloudFrontPublicKeyPem = contextString('polycastCloudFrontPublicKeyPem');

const network = new PolycastNetworkStack(app, 'PolycastNetwork', {
  env,
  description: 'Polycast Studio: VPC, NAT, endpoints, flow logs',
});
const storage = new PolycastStorageStack(app, 'PolycastStorage', {
  env,
  webOrigins: polycastWebOrigins,
  description: 'Polycast Studio: media buckets and KMS key',
});
const data = new PolycastDataStack(app, 'PolycastData', {
  env,
  vpc: network.vpc,
  encryptionKey: storage.key,
  description: 'Polycast Studio: Aurora PostgreSQL Serverless v2',
});
const auth = new PolycastAuthStack(app, 'PolycastAuth', {
  env,
  domainPrefix: polycastCognitoDomainPrefix,
  webOrigins: polycastWebOrigins,
  bootstrapAdminEmail: polycastAdminEmail,
  bootstrapAdminResendKey: polycastAdminResend,
  description: 'Polycast Studio: Cognito user pool, client, hosted UI',
});
const buckets = {
  quarantine: storage.quarantineBucket,
  source: storage.sourceBucket,
  derived: storage.derivedBucket,
  deliverables: storage.deliverablesBucket,
};
const api = new PolycastApiStack(app, 'PolycastApi', {
  env,
  vpc: network.vpc,
  encryptionKey: storage.key,
  buckets,
  database: data.cluster,
  dbOwnerSecret: data.ownerSecret,
  dbAppSecret: data.appSecret,
  userPool: auth.userPool,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  webOrigins: polycastWebOrigins,
  description: 'Polycast Studio: apps/api on Fargate behind an internal ALB',
});
new PolycastOrchestrationStack(app, 'PolycastOrchestration', {
  env,
  vpc: network.vpc,
  cluster: api.cluster,
  encryptionKey: storage.key,
  buckets,
  apiUrl: api.apiUrl,
  apiLoadBalancerSecurityGroup: api.loadBalancerSecurityGroup,
  workerTokenSecret: api.workerTokenSecret,
  sesFromAddress: polycastSesFromAddress,
  monthlyBudgetUsd: polycastMonthlyBudgetUsd,
  description: 'Polycast Studio: Step Functions, EventBridge, SQS, media worker, budget',
});
new PolycastWebStack(app, 'PolycastWeb', {
  env,
  vpc: network.vpc,
  cluster: api.cluster,
  apiInternalUrl: api.apiUrl,
  apiLoadBalancerSecurityGroup: api.loadBalancerSecurityGroup,
  derivedBucketArn: storage.derivedBucket.bucketArn,
  derivedBucketName: storage.derivedBucket.bucketName,
  webOrigins: polycastWebOrigins,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  hostedUiUrl: auth.userPoolDomain.baseUrl(),
  cloudFrontPublicKeyPem: polycastCloudFrontPublicKeyPem,
  description: 'Polycast Studio: apps/web on Fargate behind CloudFront',
});
