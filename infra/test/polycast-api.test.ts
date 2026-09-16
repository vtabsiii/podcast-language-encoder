import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildPolycastApp } from './polycast-fixture';

describe('PolycastApiStack', () => {
  const { api } = buildPolycastApp({ webOrigins: ['https://app.example.test'] });
  const template = Template.fromStack(api);

  test('internal ALB with a 300 s idle timeout and a /healthz target group', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      Type: 'application',
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'idle_timeout.timeout_seconds', Value: '300' },
      ]),
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/healthz',
      Port: 4000,
      TargetType: 'ip',
      TargetGroupAttributes: Match.arrayWith([
        { Key: 'deregistration_delay.timeout_seconds', Value: '30' },
      ]),
    });
  });

  test('/internal is not reachable from the internet: no 0.0.0.0/0 ingress on the ALB', () => {
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    const ingressCidrs = Object.values(groups).flatMap((g) =>
      (g.Properties.SecurityGroupIngress ?? []).map((r: { CidrIp?: string }) => r.CidrIp),
    );
    expect(ingressCidrs).not.toContain('0.0.0.0/0');
    const standaloneRules = template.findResources('AWS::EC2::SecurityGroupIngress');
    for (const rule of Object.values(standaloneRules)) {
      expect(rule.Properties.CidrIp).toBeUndefined();
    }
  });

  test('Fargate service: 2 x86_64 tasks (512/1024), autoscaling 2-6 on 60% CPU', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'polycast-api',
      DesiredCount: 2,
      LaunchType: 'FARGATE',
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '1024',
      RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'api',
          // CDK Docker image asset: <account>.dkr.ecr.<region>/cdk-<qualifier>-container-assets-…:<hash>
          Image: Match.objectLike({
            'Fn::Sub': Match.stringLikeRegexp('container-assets-.*:[0-9a-f]{64}$'),
          }),
          PortMappings: [Match.objectLike({ ContainerPort: 4000 })],
        }),
      ],
    });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 2,
      MaxCapacity: 6,
    });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        TargetValue: 60,
        PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' },
      }),
    });
  });

  test('container env matches the production fail-closed config and injects secrets by field', () => {
    const env = (name: string, value: unknown) => Match.objectLike({ Name: name, Value: value });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'api',
          Environment: Match.arrayWith([
            env('NODE_ENV', 'production'),
            env('HOST', '0.0.0.0'),
            env('PORT', '4000'),
            env('PROVIDER_MODE', 'aws'),
            env('STORAGE_DRIVER', 's3'),
            env('AUTH_MODE', 'cognito'),
            env('ORCHESTRATOR', 'step-functions'),
            env('CORS_ORIGINS', 'https://app.example.test'),
            env('SIGNED_URL_TTL_SECONDS', '900'),
            env('DB_NAME', 'polycast'),
            env('DB_SSL', 'require'),
            env('EVENT_BUS_NAME', 'polycast-events'),
          ]),
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'WORKER_TOKEN' }),
            Match.objectLike({ Name: 'LOCAL_JWT_SECRET' }),
            Match.objectLike({
              Name: 'DB_OWNER_PASSWORD',
              ValueFrom: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([':password::'])] }),
            }),
            Match.objectLike({
              Name: 'DB_APP_USER',
              ValueFrom: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([':username::'])] }),
            }),
          ]),
        }),
      ],
    });
    // The env must not carry composed database URLs (they would embed the password).
    const defs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    for (const def of defs) {
      for (const container of def.Properties.ContainerDefinitions) {
        const names = (container.Environment ?? []).map((e: { Name: string }) => e.Name);
        expect(names).not.toContain('DATABASE_URL');
        expect(names).not.toContain('DATABASE_APP_URL');
      }
    }
  });

  test('separate migration task definition runs the migrate CLI', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'polycast-migrate',
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'migrate',
          Command: ['node', 'dist/db/migrate-cli.js'],
          Secrets: Match.arrayWith([Match.objectLike({ Name: 'DB_OWNER_PASSWORD' })]),
        }),
      ],
    });
    template.hasOutput('MigrateTaskDefinitionArn', {});
    template.hasOutput('MigrateSecurityGroupId', {});
  });

  test('image is a CDK asset built from apps/api/Dockerfile; no application ECR repository', () => {
    template.resourceCountIs('AWS::ECR::Repository', 0);
    const assets = Object.values(
      Template.fromStack(api).toJSON().Resources as Record<string, { Type: string }>,
    ).filter((r) => r.Type === 'AWS::ECR::Repository');
    expect(assets).toHaveLength(0);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'api',
          Environment: Match.arrayWith([
            { Name: 'DB_SSL', Value: 'require' },
            { Name: 'DB_SSL_ROOT_CERT', Value: '/etc/ssl/certs/aws-rds-global-bundle.pem' },
          ]),
        }),
      ],
    });
  });

  test('migration custom resource runs the migrate task before the API service', () => {
    template.hasResourceProperties('Custom::PolycastMigration', {
      ContainerName: 'migrate',
      LogStreamPrefix: 'migrate',
      LogGroupName: Match.objectLike({ Ref: Match.stringLikeRegexp('ApiLogs') }),
      TaskDefinitionArn: Match.objectLike({ Ref: Match.stringLikeRegexp('MigrateTask') }),
      SecurityGroupIds: [Match.objectLike({ 'Fn::GetAtt': Match.arrayWith(['GroupId']) })],
    });
    const services = template.findResources('AWS::ECS::Service', {
      Properties: { ServiceName: 'polycast-api' },
    });
    const service = Object.values(services)[0] as { DependsOn?: string[] };
    expect(service.DependsOn).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Migration[0-9A-F]*$/)]),
    );
    // Only the migrate task family may be started, only on the Polycast cluster.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ecs:RunTask',
            Resource: Match.objectLike({ Ref: Match.stringLikeRegexp('MigrateTask') }),
            Condition: { ArnEquals: { 'ecs:cluster': Match.anyValue() } },
          }),
        ]),
      }),
    });
  });

  test('task role: buckets, Step Functions by name pattern, EventBridge bus', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'states:StartExecution',
            Resource: Match.objectLike({
              'Fn::Join': ['', Match.arrayWith([':stateMachine:polycast-*'])],
            }),
          }),
          Match.objectLike({
            Sid: 'ResolveTaskTokens',
            // Single element: action order differs between CLI (minimizePolicies) and jest.
            Action: Match.arrayWith(['states:SendTaskSuccess']),
            Resource: '*',
          }),
          Match.objectLike({
            Action: 'events:PutEvents',
            Resource: Match.objectLike({
              'Fn::Join': ['', Match.arrayWith([':event-bus/polycast-events'])],
            }),
          }),
        ]),
      }),
    });
  });

  test('alarms: 5xx rate, unhealthy hosts, p95 latency over 300 ms for 5 minutes', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'UnHealthyHostCount',
      Threshold: 0,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 0.3,
      EvaluationPeriods: 5,
      ExtendedStatistic: 'p95',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 5,
      Metrics: Match.arrayWith([Match.objectLike({ Expression: Match.stringLikeRegexp('elb') })]),
    });
  });

  test('worker token is a generated secret exported for the orchestration stack', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ ExcludePunctuation: true, PasswordLength: 48 }),
    });
    template.hasOutput('ApiInternalUrl', {});
    template.hasOutput('WorkerTokenSecretArn', {});
  });
});
