import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { tagPolycastStack } from './polycast-common';

export interface PolycastStorageStackProps extends cdk.StackProps {
  /**
   * Browser origins allowed to PUT upload parts straight to the quarantine bucket
   * (architecture.md §5.1). Defaults to the local web origin.
   */
  webOrigins?: string[];
}

/**
 * The four media buckets from the retention map (architecture.md §10) plus the customer-managed
 * KMS key that encrypts them, the SQS queues and the Aurora storage.
 *
 * | Bucket       | Purpose                                   | Retention                          |
 * |--------------|-------------------------------------------|------------------------------------|
 * | quarantine   | browser uploads before validation         | 1 day, CORS for the web origins    |
 * | source       | immutable validated copy                  | versioned, object lock 30 d, old   |
 * |              |                                           | versions expire after 365 d        |
 * | derived      | proxies, waveforms, stems, stage outputs  | 90 d                               |
 * | deliverables | packaged outputs                          | versioned, never expires           |
 *
 * Object keys are tenant-prefixed `{organizationId}/...`; the API scopes every key it signs.
 * Every bucket is RETAIN (CLAUDE.md), blocks all public access, requires TLS and uses the key.
 */
export class PolycastStorageStack extends cdk.Stack {
  public readonly key: kms.Key;
  public readonly quarantineBucket: s3.Bucket;
  public readonly sourceBucket: s3.Bucket;
  public readonly derivedBucket: s3.Bucket;
  public readonly deliverablesBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: PolycastStorageStackProps = {}) {
    super(scope, id, props);
    tagPolycastStack(this, 'storage');

    const webOrigins = props.webOrigins ?? ['http://localhost:3000'];

    this.key = new kms.Key(this, 'MediaKey', {
      description: 'Polycast Studio: media buckets, queues and database storage',
      alias: 'alias/polycast-media',
      enableKeyRotation: true,
      pendingWindow: cdk.Duration.days(30),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const bucketDefaults: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    };
    // Deterministic names (no dots, so path-style and virtual-hosted URLs both work) that
    // match the API's MEDIA_BUCKET_* defaults with an account/region suffix for uniqueness.
    const bucketName = (suffix: string) => `polycast-${suffix}-${this.account}-${this.region}`;

    this.quarantineBucket = new s3.Bucket(this, 'QuarantineBucket', {
      ...bucketDefaults,
      bucketName: bucketName('quarantine'),
      eventBridgeEnabled: true,
      lifecycleRules: [
        {
          id: 'expire-unvalidated-uploads',
          expiration: cdk.Duration.days(1),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: webOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
    });

    this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      ...bucketDefaults,
      bucketName: bucketName('source'),
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(cdk.Duration.days(30)),
      lifecycleRules: [
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: cdk.Duration.days(365),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // The review studio fetches waveforms and audio through presigned GET URLs from the
    // browser, which needs CORS for the web origins (media elements do not, fetch() does).
    const readOnlyCors: s3.CorsRule[] = [
      {
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: webOrigins,
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
        maxAge: 3600,
      },
    ];

    this.derivedBucket = new s3.Bucket(this, 'DerivedBucket', {
      ...bucketDefaults,
      bucketName: bucketName('derived'),
      cors: readOnlyCors,
      lifecycleRules: [
        {
          id: 'expire-derived',
          expiration: cdk.Duration.days(90),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    this.deliverablesBucket = new s3.Bucket(this, 'DeliverablesBucket', {
      ...bucketDefaults,
      bucketName: bucketName('deliverables'),
      cors: readOnlyCors,
      versioned: true,
      lifecycleRules: [
        { id: 'abort-incomplete', abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
      ],
    });

    // `/media/*` on the CloudFront distribution (PolycastWeb) reads the derived bucket through
    // an origin access control. The distribution id is only known in the web stack, which
    // already depends on this one, so the policy admits any distribution of this account
    // rather than creating a CloudFormation cycle. Signed-URL key groups still gate viewers.
    const anyDistributionOfThisAccount = `arn:${this.partition}:cloudfront::${this.account}:distribution/*`;
    this.derivedBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontOriginAccessControl',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.derivedBucket.arnForObjects('*')],
        conditions: { ArnLike: { 'AWS:SourceArn': anyDistributionOfThisAccount } },
      }),
    );
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontOriginAccessControl',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { ArnLike: { 'AWS:SourceArn': anyDistributionOfThisAccount } },
      }),
    );

    new cdk.CfnOutput(this, 'MediaKeyArn', { value: this.key.keyArn });
    new cdk.CfnOutput(this, 'QuarantineBucketName', { value: this.quarantineBucket.bucketName });
    new cdk.CfnOutput(this, 'SourceBucketName', { value: this.sourceBucket.bucketName });
    new cdk.CfnOutput(this, 'DerivedBucketName', { value: this.derivedBucket.bucketName });
    new cdk.CfnOutput(this, 'DeliverablesBucketName', {
      value: this.deliverablesBucket.bucketName,
    });
  }
}
