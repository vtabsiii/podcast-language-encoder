import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PodcastLanguageEncoderStack } from '../lib/podcast-language-encoder-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

describe('PodcastLanguageEncoderStack', () => {
  const app = new cdk.App();
  const stack = new PodcastLanguageEncoderStack(app, 'Test', { targetLanguages: ['es', 'fr'] });
  const template = Template.fromStack(stack);

  test('creates private, encrypted input and output buckets', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
      BucketEncryption: Match.anyValue(),
    });
  });

  test('input bucket publishes to EventBridge and a rule starts the state machine', () => {
    // CDK wires S3 -> EventBridge through a notifications custom resource.
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: { EventBridgeConfiguration: {} },
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
        detail: Match.objectLike({ object: { key: [{ prefix: 'episodes/' }] } }),
      }),
    });
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  });

  test('lambda receives the configured target languages', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: { Variables: Match.objectLike({ TARGET_LANGUAGES: 'es,fr' }) },
    });
  });
});

describe('GithubOidcStack', () => {
  const app = new cdk.App();
  const stack = new GithubOidcStack(app, 'Oidc', {
    githubOwner: 'vtabsiii',
    githubRepo: 'podcast-language-encoder',
  });
  const template = Template.fromStack(stack);

  test('deploy role trusts only this repository', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'podcast-language-encoder-github-deploy',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': Match.arrayWith([
                  'repo:vtabsiii/podcast-language-encoder:ref:refs/heads/main',
                ]),
              },
            }),
          }),
        ],
      }),
    });
  });
});
