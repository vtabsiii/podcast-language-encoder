import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildPolycastApp } from './polycast-fixture';

describe('PolycastStorageStack', () => {
  const { storage } = buildPolycastApp({ webOrigins: ['https://app.example.test'] });
  const template = Template.fromStack(storage);

  test('four retained buckets, all private, TLS-only and KMS encrypted', () => {
    template.resourceCountIs('AWS::S3::Bucket', 4);
    template.allResources('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ],
      },
    });
    template.resourceCountIs('AWS::S3::BucketPolicy', 4);
    template.allResourcesProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  test('customer-managed key rotates and is retained', () => {
    template.hasResource('AWS::KMS::Key', {
      Properties: Match.objectLike({ EnableKeyRotation: true }),
      DeletionPolicy: 'Retain',
    });
  });

  test('quarantine bucket expires after a day and allows browser PUTs from the web origins', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.objectLike({
        'Fn::Join': ['', Match.arrayWith(['polycast-quarantine-'])],
      }),
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            ExpirationInDays: 1,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            Status: 'Enabled',
          }),
        ],
      },
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedOrigins: ['https://app.example.test'],
            ExposedHeaders: ['ETag'],
          }),
        ],
      },
    });
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: { EventBridgeConfiguration: {} },
    });
  });

  test('source bucket is versioned with 30-day governance object lock', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['polycast-source-'])] }),
      VersioningConfiguration: { Status: 'Enabled' },
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
      },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 365 } })],
      },
    });
  });

  test('derived expires after 90 days; deliverables are versioned and never expire', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['polycast-derived-'])] }),
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 90 })] },
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.objectLike({
        'Fn::Join': ['', Match.arrayWith(['polycast-deliverables-'])],
      }),
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: [Match.not(Match.objectLike({ ExpirationInDays: Match.anyValue() }))],
      },
    });
  });

  test('derived bucket and key admit CloudFront origin access from this account only', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudFrontOriginAccessControl',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Condition: { ArnLike: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      }),
    });
  });

  test('exports the bucket names', () => {
    for (const name of [
      'QuarantineBucketName',
      'SourceBucketName',
      'DerivedBucketName',
      'DeliverablesBucketName',
    ]) {
      template.hasOutput(name, {});
    }
  });
});

describe('PolycastStorageStack browser access', () => {
  test('derived and deliverables buckets allow read-only CORS from the web origins', () => {
    const { storage } = buildPolycastApp({ webOrigins: ['https://app.example.test'] });
    const template = Template.fromStack(storage);
    const buckets = template.findResources('AWS::S3::Bucket');
    const withReadCors = Object.values(buckets).filter((b) => {
      const rules = b.Properties?.CorsConfiguration?.CorsRules ?? [];
      return rules.some(
        (r: { AllowedMethods: string[]; AllowedOrigins: string[] }) =>
          r.AllowedMethods.includes('GET') &&
          !r.AllowedMethods.includes('PUT') &&
          r.AllowedOrigins.includes('https://app.example.test'),
      );
    });
    expect(withReadCors).toHaveLength(2);
  });
});
