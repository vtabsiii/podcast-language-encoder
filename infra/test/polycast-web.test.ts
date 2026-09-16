import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildPolycastApp, TEST_PUBLIC_KEY_PEM } from './polycast-fixture';

describe('PolycastWebStack', () => {
  const { web } = buildPolycastApp();
  const template = Template.fromStack(web);

  test('public ALB answers 403 unless the CloudFront origin header matches', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'idle_timeout.timeout_seconds', Value: '300' },
      ]),
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({ StatusCode: '403' }),
        }),
      ],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [
        Match.objectLike({
          Field: 'http-header',
          HttpHeaderConfig: Match.objectLike({
            HttpHeaderName: 'X-Origin-Verify',
            Values: [
              Match.objectLike({
                'Fn::Join': ['', Match.arrayWith(['{{resolve:secretsmanager:'])],
              }),
            ],
          }),
        }),
      ],
      Actions: [Match.objectLike({ Type: 'forward' })],
    });
  });

  test('web service: 2 x86_64 tasks with API_BASE_URL pointing at the internal API ALB', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'polycast-web',
      DesiredCount: 2,
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '1024',
      RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'web',
          PortMappings: [Match.objectLike({ ContainerPort: 3000 })],
          Environment: Match.arrayWith([
            { Name: 'NODE_ENV', Value: 'production' },
            { Name: 'PORT', Value: '3000' },
            {
              Name: 'API_BASE_URL',
              Value: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['http://'])] }),
            },
            { Name: 'AUTH_MODE', Value: 'cognito' },
            Match.objectLike({ Name: 'COGNITO_CLIENT_ID' }),
            Match.objectLike({ Name: 'COGNITO_HOSTED_UI_URL' }),
            { Name: 'WEB_ORIGIN', Value: 'https://app.example.test' },
          ]),
          Image: Match.objectLike({
            'Fn::Sub': Match.stringLikeRegexp('container-assets-.*:[0-9a-f]{64}$'),
          }),
        }),
      ],
    });
    template.resourceCountIs('AWS::ECR::Repository', 0);
  });

  test('web tier gets an ingress rule on the API ALB security group, placed in this stack', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      Description: 'Polycast web tier to API internal ALB',
      GroupId: Match.objectLike({ 'Fn::ImportValue': Match.anyValue() }),
    });
  });

  test('CloudFront: HTTPS-only viewers, no caching for dynamic paths, cached /_next/static', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Enabled: true,
        HttpVersion: 'http2and3',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'https-only',
          AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CACHING_DISABLED
          OriginRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3', // ALL_VIEWER
          ResponseHeadersPolicyId: Match.anyValue(),
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/_next/static/*',
            ViewerProtocolPolicy: 'https-only',
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // CACHING_OPTIMIZED
          }),
          Match.objectLike({
            PathPattern: '/api/*',
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          }),
        ]),
        Origins: [
          Match.objectLike({
            CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'http-only' }),
            OriginCustomHeaders: [Match.objectLike({ HeaderName: 'X-Origin-Verify' })],
          }),
        ],
      }),
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 0);
    const paths = template
      .findResources('AWS::CloudFront::Distribution')
      [
        Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0]
      ].Properties.DistributionConfig.CacheBehaviors.map(
        (b: { PathPattern: string }) => b.PathPattern,
      );
    expect(paths).not.toContain('/media/*');
    template.hasOutput('MediaBehavior', { Value: Match.stringLikeRegexp('^disabled') });
  });

  test('security headers policy: HSTS, nosniff, referrer policy, frame DENY', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 31536000,
            IncludeSubdomains: true,
            Preload: true,
            Override: true,
          }),
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: Match.objectLike({ ReferrerPolicy: 'no-referrer' }),
          FrameOptions: { FrameOption: 'DENY', Override: true },
        },
      }),
    });
  });

  test('no buckets of its own; the distribution domain is exported for the web origin', () => {
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.hasOutput('DistributionDomainName', {});
  });
});

describe('PolycastWebStack with a CloudFront public key', () => {
  const { web } = buildPolycastApp({ cloudFrontPublicKeyPem: TEST_PUBLIC_KEY_PEM });
  const template = Template.fromStack(web);

  test('adds /media/* from the derived bucket restricted to a key group', () => {
    template.hasResourceProperties('AWS::CloudFront::PublicKey', {
      PublicKeyConfig: Match.objectLike({ EncodedKey: TEST_PUBLIC_KEY_PEM }),
    });
    template.resourceCountIs('AWS::CloudFront::KeyGroup', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/media/*',
            ViewerProtocolPolicy: 'https-only',
            TrustedKeyGroups: [Match.anyValue()],
          }),
        ]),
      }),
    });
    template.hasOutput('MediaBehavior', {
      Value: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['enabled: key group '])] }),
    });
    template.hasOutput('MediaPublicKeyId', {});
  });
});
