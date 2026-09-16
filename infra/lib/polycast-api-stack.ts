import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  POLYCAST_CHILD_STATE_MACHINE_NAME,
  POLYCAST_EVENT_BUS_NAME,
  POLYCAST_PARENT_STATE_MACHINE_NAME,
  polycastEventBusArn,
  polycastExecutionArnPattern,
  polycastStateMachineArn,
  polycastContainerImage,
  polycastStateMachineArnPattern,
  tagPolycastStack,
} from './polycast-common';

/** Aurora PostgreSQL default port (PolycastData does not override it). */
const POSTGRES_PORT = 5432;

export interface PolycastMediaBuckets {
  quarantine: s3.IBucket;
  source: s3.IBucket;
  derived: s3.IBucket;
  deliverables: s3.IBucket;
}

export interface PolycastApiStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  encryptionKey: kms.IKey;
  buckets: PolycastMediaBuckets;
  database: rds.IDatabaseCluster;
  dbOwnerSecret: secretsmanager.ISecret;
  dbAppSecret: secretsmanager.ISecret;
  userPool: cognito.IUserPool;
  userPoolClientId: string;
  /** Browser origins for CORS_ORIGINS. */
  webOrigins: string[];
  /** PUBLIC_API_URL for the API; defaults to the internal ALB URL (only the web tier and workers call it). */
  publicApiUrl?: string;
}

/**
 * `apps/api` on ECS Fargate behind an INTERNAL application load balancer.
 *
 * Nothing on the internet reaches this ALB: the web tier proxies `/api/*` to it (ADR-0001), the
 * media worker calls `/internal/v1` on it, and both are admitted by security-group rules that
 * the web and orchestration stacks add. `/internal/*` is therefore unreachable from outside
 * the VPC without any listener rule (asserted in `test/polycast-api.test.ts`).
 *
 * Runtime configuration matches `apps/api/src/config.ts` production fail-closed rules. Database
 * credentials are injected field by field from Secrets Manager (`DB_*`), never as URLs.
 *
 * The image is a CDK Docker image asset built from `apps/api/Dockerfile` and published by
 * `cdk deploy`; no application-owned ECR repository exists (docs/aws-setup.md).
 *
 * `MigrateTask` is a separate task definition running `node dist/db/migrate-cli.js` with the
 * owner secret. The `Migration` custom resource runs it during every deploy whose task
 * definition changed and blocks the API service until it exits 0, so the schema is always
 * ahead of the code that serves it (docs/aws-setup.md).
 */
export class PolycastApiStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly serviceSecurityGroup: ec2.SecurityGroup;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
  /** `http://<internal alb dns>`; the web tier's API_BASE_URL and the worker's --api-url. */
  public readonly apiUrl: string;
  public readonly workerTokenSecret: secretsmanager.Secret;
  public readonly migrateTaskDefinition: ecs.FargateTaskDefinition;
  public readonly migrateSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: PolycastApiStackProps) {
    super(scope, id, props);
    tagPolycastStack(this, 'api');

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'polycast',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ------------------------------------------------------------- secrets
    this.workerTokenSecret = new secretsmanager.Secret(this, 'WorkerToken', {
      description: 'Polycast: shared secret media workers present on /internal/v1',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    const jwtSecret = new secretsmanager.Secret(this, 'LocalJwtSecret', {
      description:
        'Polycast: LOCAL_JWT_SECRET (signs local-storage URLs only under STORAGE_DRIVER=s3)',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });

    // ------------------------------------------------------------ load balancer
    this.loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Polycast API internal ALB: ingress only from the web tier and media workers',
      allowAllOutbound: true,
    });
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: this.loadBalancerSecurityGroup,
      // SSE on /api/v1/events keeps connections open; default 60 s would cut them.
      idleTimeout: cdk.Duration.seconds(300),
      dropInvalidHeaderFields: true,
    });
    this.apiUrl = `http://${this.loadBalancer.loadBalancerDnsName}`;
    const publicApiUrl = props.publicApiUrl ?? this.apiUrl;

    // --------------------------------------------------------------- task
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '4000',
      AWS_REGION: this.region,
      PROVIDER_MODE: 'aws',
      STORAGE_DRIVER: 's3',
      AUTH_MODE: 'cognito',
      ORCHESTRATOR: 'step-functions',
      PUBLIC_API_URL: publicApiUrl,
      CORS_ORIGINS: props.webOrigins.join(','),
      SIGNED_URL_TTL_SECONDS: '900',
      MEDIA_BUCKET_QUARANTINE: props.buckets.quarantine.bucketName,
      MEDIA_BUCKET_SOURCE: props.buckets.source.bucketName,
      MEDIA_BUCKET_DERIVED: props.buckets.derived.bucketName,
      MEDIA_BUCKET_DELIVERABLES: props.buckets.deliverables.bucketName,
      COGNITO_USER_POOL_ID: props.userPool.userPoolId,
      COGNITO_CLIENT_ID: props.userPoolClientId,
      DB_HOST: props.database.clusterEndpoint.hostname,
      DB_PORT: cdk.Tokenization.stringifyNumber(props.database.clusterEndpoint.port),
      DB_NAME: 'polycast',
      DB_SSL: 'require',
      // Amazon RDS certificate bundle baked into the image (apps/api/Dockerfile): the client
      // verifies the Aurora certificate chain and host name (sslmode=verify-full).
      DB_SSL_ROOT_CERT: '/etc/ssl/certs/aws-rds-global-bundle.pem',
      // Orchestration resources are addressed by name so this stack never depends on them.
      EVENT_BUS_NAME: POLYCAST_EVENT_BUS_NAME,
      SFN_PARENT_STATE_MACHINE_ARN: polycastStateMachineArn(
        this,
        POLYCAST_PARENT_STATE_MACHINE_NAME,
      ),
      SFN_CHILD_STATE_MACHINE_ARN: polycastStateMachineArn(this, POLYCAST_CHILD_STATE_MACHINE_NAME),
    };
    const secrets: Record<string, ecs.Secret> = {
      WORKER_TOKEN: ecs.Secret.fromSecretsManager(this.workerTokenSecret),
      LOCAL_JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
      DB_OWNER_USER: ecs.Secret.fromSecretsManager(props.dbOwnerSecret, 'username'),
      DB_OWNER_PASSWORD: ecs.Secret.fromSecretsManager(props.dbOwnerSecret, 'password'),
      DB_APP_USER: ecs.Secret.fromSecretsManager(props.dbAppSecret, 'username'),
      DB_APP_PASSWORD: ecs.Secret.fromSecretsManager(props.dbAppSecret, 'password'),
    };
    const image = polycastContainerImage(this, 'Image', 'apps/api/Dockerfile');
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Polycast API: media buckets, Step Functions, EventBridge',
    });
    for (const bucket of Object.values(props.buckets)) bucket.grantReadWrite(taskRole);
    props.encryptionKey.grantEncryptDecrypt(taskRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartPolycastExecutions',
        actions: ['states:StartExecution'],
        resources: [polycastStateMachineArnPattern(this)],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InspectPolycastExecutions',
        actions: ['states:DescribeExecution', 'states:StopExecution'],
        resources: [polycastExecutionArnPattern(this)],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        // Task-token callbacks (approve endpoint resolves NEEDS_REVIEW) have no resource scope.
        sid: 'ResolveTaskTokens',
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure', 'states:SendTaskHeartbeat'],
        resources: ['*'],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishPolycastEvents',
        actions: ['events:PutEvents'],
        resources: [polycastEventBusArn(this)],
      }),
    );

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const container = taskDefinition.addContainer('api', {
      image,
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
      portMappings: [{ containerPort: 4000, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:4000/healthz || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        startPeriod: cdk.Duration.seconds(30),
        retries: 3,
      },
    });

    this.serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'Polycast API tasks',
      allowAllOutbound: true,
    });
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      serviceName: 'polycast-api',
      taskDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.serviceSecurityGroup],
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    // The rule lives in this stack (remoteRule=true) so PolycastData never references it.
    props.database.connections.securityGroups[0].addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(POSTGRES_PORT),
      'Polycast API tasks',
      true,
    );

    const listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false, // ingress is granted per caller security group, never 0.0.0.0/0
    });
    const targetGroup = listener.addTargets('Api', {
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service.loadBalancerTarget({ containerName: container.containerName })],
      healthCheck: {
        path: '/healthz',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    const scaling = this.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });

    // ------------------------------------------------------------ migrations
    this.migrateSecurityGroup = new ec2.SecurityGroup(this, 'MigrateSecurityGroup', {
      vpc: props.vpc,
      description: 'Polycast one-off migration task',
      allowAllOutbound: true,
    });
    props.database.connections.securityGroups[0].addIngressRule(
      this.migrateSecurityGroup,
      ec2.Port.tcp(POSTGRES_PORT),
      'Polycast migration task',
      true,
    );
    this.migrateTaskDefinition = new ecs.FargateTaskDefinition(this, 'MigrateTask', {
      family: 'polycast-migrate',
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    this.migrateTaskDefinition.addContainer('migrate', {
      image,
      command: ['node', 'dist/db/migrate-cli.js'],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'migrate' }),
    });

    // Runs the migration task on every deploy that changes it and blocks the API service until
    // it has exited 0 (the task definition ARN carries the revision, so a new image or a new
    // environment variable re-runs it). Failures roll the stack back.
    const migrationFn = (name: string, handler: 'onEvent' | 'isComplete') =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, '..', 'lambda', 'run-migration', 'index.ts'),
        handler,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(30),
        description: `Polycast: ${handler} for the database migration task`,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, sourceMap: false, target: 'node22' },
      });
    const migrationStart = migrationFn('MigrationStartFn', 'onEvent');
    const migrationPoll = migrationFn('MigrationPollFn', 'isComplete');
    for (const fn of [migrationStart, migrationPoll]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'RunMigrationTask',
          actions: ['ecs:RunTask'],
          resources: [this.migrateTaskDefinition.taskDefinitionArn],
          conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'DescribeMigrationTask',
          actions: ['ecs:DescribeTasks'],
          resources: ['*'],
          conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'PassMigrationRoles',
          actions: ['iam:PassRole'],
          resources: [taskRole.roleArn, this.migrateTaskDefinition.obtainExecutionRole().roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      );
    }
    const migrationProvider = new cr.Provider(this, 'MigrationProvider', {
      onEventHandler: migrationStart,
      isCompleteHandler: migrationPoll,
      queryInterval: cdk.Duration.seconds(15),
      totalTimeout: cdk.Duration.minutes(30),
      logGroup: new logs.LogGroup(this, 'MigrationProviderLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    const migration = new cdk.CustomResource(this, 'Migration', {
      serviceToken: migrationProvider.serviceToken,
      resourceType: 'Custom::PolycastMigration',
      properties: {
        ClusterArn: this.cluster.clusterArn,
        TaskDefinitionArn: this.migrateTaskDefinition.taskDefinitionArn,
        SubnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
          .subnetIds,
        SecurityGroupIds: [this.migrateSecurityGroup.securityGroupId],
        ContainerName: 'migrate',
      },
    });
    // The ingress rule to the database lives under the migrate security group (remoteRule);
    // depending on the group covers it. The service waits for the schema.
    migration.node.addDependency(this.migrateSecurityGroup);
    this.service.node.addDependency(migration);

    // ---------------------------------------------------------------- alarms
    const period = cdk.Duration.minutes(1);
    const requests = this.loadBalancer.metrics.requestCount({ period, statistic: 'Sum' });
    const elb5xx = this.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period,
      statistic: 'Sum',
    });
    const target5xx = this.loadBalancer.metrics.httpCodeTarget(
      elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
      { period, statistic: 'Sum' },
    );
    new cloudwatch.Alarm(this, 'Http5xxRate', {
      alarmDescription: 'Polycast API: more than 5% of requests answered 5xx for 5 minutes',
      metric: new cloudwatch.MathExpression({
        // Division by zero yields no data point (treated as not breaching); metric math does
        // not allow mixing a scalar into MAX([...]).
        expression: '100 * (elb + target) / requests',
        usingMetrics: { elb: elb5xx, target: target5xx, requests },
        period,
        label: '5xx %',
      }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'UnhealthyHosts', {
      alarmDescription: 'Polycast API: at least one target failing /healthz',
      metric: targetGroup.metrics.unhealthyHostCount({ period, statistic: 'Maximum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'LatencyP95', {
      alarmDescription: 'Polycast API: p95 target response time above 300 ms for 5 minutes',
      metric: targetGroup.metrics.targetResponseTime({ period, statistic: 'p95' }),
      threshold: 0.3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'ApiInternalUrl', { value: this.apiUrl });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'WorkerTokenSecretArn', { value: this.workerTokenSecret.secretArn });
    new cdk.CfnOutput(this, 'MigrateTaskDefinitionArn', {
      value: this.migrateTaskDefinition.taskDefinitionArn,
      description:
        'Run by the Migration custom resource on each deploy; also usable with aws ecs run-task (docs/aws-setup.md)',
    });
    new cdk.CfnOutput(this, 'MigrateSecurityGroupId', {
      value: this.migrateSecurityGroup.securityGroupId,
    });
  }
}
