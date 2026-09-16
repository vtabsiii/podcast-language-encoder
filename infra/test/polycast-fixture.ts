import * as cdk from 'aws-cdk-lib';
import { PolycastNetworkStack } from '../lib/polycast-network-stack';
import { PolycastStorageStack } from '../lib/polycast-storage-stack';
import { PolycastDataStack } from '../lib/polycast-data-stack';
import { PolycastAuthStack } from '../lib/polycast-auth-stack';
import { PolycastApiStack } from '../lib/polycast-api-stack';
import { PolycastOrchestrationStack } from '../lib/polycast-orchestration-stack';
import { PolycastWebStack } from '../lib/polycast-web-stack';

export interface PolycastFixtureOptions {
  webOrigins?: string[];
  cloudFrontPublicKeyPem?: string;
  monthlyBudgetUsd?: number;
  sesFromAddress?: string;
  bootstrapAdminEmail?: string;
}

/**
 * Builds the seven Polycast stacks exactly as `bin/podcast-language-encoder.ts` wires them.
 * Bundling is disabled (`aws:cdk:bundling-stacks: []`) so tests never invoke esbuild.
 */
export function buildPolycastApp(options: PolycastFixtureOptions = {}) {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const webOrigins = options.webOrigins ?? ['https://app.example.test'];

  const network = new PolycastNetworkStack(app, 'PolycastNetwork');
  const storage = new PolycastStorageStack(app, 'PolycastStorage', { webOrigins });
  const data = new PolycastDataStack(app, 'PolycastData', {
    vpc: network.vpc,
    encryptionKey: storage.key,
  });
  const auth = new PolycastAuthStack(app, 'PolycastAuth', {
    domainPrefix: 'polycast-test',
    webOrigins,
    bootstrapAdminEmail: options.bootstrapAdminEmail,
  });
  const buckets = {
    quarantine: storage.quarantineBucket,
    source: storage.sourceBucket,
    derived: storage.derivedBucket,
    deliverables: storage.deliverablesBucket,
  };
  const api = new PolycastApiStack(app, 'PolycastApi', {
    vpc: network.vpc,
    encryptionKey: storage.key,
    buckets,
    database: data.cluster,
    dbOwnerSecret: data.ownerSecret,
    dbAppSecret: data.appSecret,
    userPool: auth.userPool,
    userPoolClientId: auth.userPoolClient.userPoolClientId,
    webOrigins,
  });
  const orchestration = new PolycastOrchestrationStack(app, 'PolycastOrchestration', {
    vpc: network.vpc,
    cluster: api.cluster,
    encryptionKey: storage.key,
    buckets,
    apiUrl: api.apiUrl,
    apiLoadBalancerSecurityGroup: api.loadBalancerSecurityGroup,
    workerTokenSecret: api.workerTokenSecret,
    sesFromAddress: options.sesFromAddress,
    monthlyBudgetUsd: options.monthlyBudgetUsd,
  });
  const web = new PolycastWebStack(app, 'PolycastWeb', {
    vpc: network.vpc,
    cluster: api.cluster,
    apiInternalUrl: api.apiUrl,
    apiLoadBalancerSecurityGroup: api.loadBalancerSecurityGroup,
    derivedBucketArn: storage.derivedBucket.bucketArn,
    derivedBucketName: storage.derivedBucket.bucketName,
    webOrigins,
    userPoolId: auth.userPool.userPoolId,
    userPoolClientId: auth.userPoolClient.userPoolClientId,
    hostedUiUrl: auth.userPoolDomain.baseUrl(),
    cloudFrontPublicKeyPem: options.cloudFrontPublicKeyPem,
  });

  return { app, network, storage, data, auth, api, orchestration, web };
}

/** A syntactically plausible RSA public key for the CloudFront key group tests. */
export const TEST_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkeytestkeytestkeytest',
  'keytestkeytestkeytestkeytestkeytestkeytestkeytestkeytestkeytestkey',
  '-----END PUBLIC KEY-----',
].join('\n');
