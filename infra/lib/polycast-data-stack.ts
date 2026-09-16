import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { tagPolycastStack } from './polycast-common';

export interface PolycastDataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /** Customer-managed key from PolycastStorage used for storage encryption. */
  encryptionKey: kms.IKey;
  /** Aurora Serverless v2 capacity range in ACUs. */
  minCapacity?: number;
  maxCapacity?: number;
}

/**
 * Aurora PostgreSQL Serverless v2 for the control plane (ADR-0003, assumption A-10).
 *
 * - One cluster, one database `polycast`, writer only (add a reader when NFR-007 needs it).
 * - `polycast` owner credentials generated in Secrets Manager and rotated every 30 days
 *   (`ownerSecret`, JSON with username/password/host/port/dbname); the migration task uses it.
 * - `polycast_app` least-privilege role credentials in a second generated secret
 *   (`appSecret`, JSON with username/password). The migration creates or realigns the role
 *   from `DB_APP_PASSWORD`; request handlers connect with it so RLS cannot be bypassed.
 * - `rds.force_ssl=1`: the API sets `DB_SSL=require`.
 * - 35-day PITR, deletion protection, snapshot on stack delete.
 */
export class PolycastDataStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly ownerSecret: secretsmanager.ISecret;
  public readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: PolycastDataStackProps) {
    super(scope, id, props);
    tagPolycastStack(this, 'data');

    const minCapacity = props.minCapacity ?? 0.5;
    const maxCapacity = props.maxCapacity ?? 4;
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_16_13,
    });

    const parameterGroup = new rds.ParameterGroup(this, 'ClusterParameters', {
      engine,
      description: 'Polycast: require TLS for every connection',
      parameters: { 'rds.force_ssl': '1' },
    });

    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine,
      writer: rds.ClusterInstance.serverlessV2('Writer', { publiclyAccessible: false }),
      serverlessV2MinCapacity: minCapacity,
      serverlessV2MaxCapacity: maxCapacity,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromGeneratedSecret('polycast'),
      defaultDatabaseName: 'polycast',
      parameterGroup,
      storageEncrypted: true,
      storageEncryptionKey: props.encryptionKey,
      backup: { retention: cdk.Duration.days(35), preferredWindow: '06:00-07:00' },
      preferredMaintenanceWindow: 'sun:07:00-sun:08:00',
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      copyTagsToSnapshot: true,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });

    if (!this.cluster.secret) {
      throw new Error('Aurora cluster must generate its owner secret');
    }
    this.ownerSecret = this.cluster.secret;
    this.cluster.addRotationSingleUser({ automaticallyAfter: cdk.Duration.days(30) });

    // 'AppSecretV2': the first secret's value was echoed into deploy logs by a failed
    // migration on 2026-09-16; a new construct id replaces the secret with a fresh value and
    // the next migration realigns the role. Never reuse the old id.
    this.appSecret = new secretsmanager.Secret(this, 'AppSecretV2', {
      description: 'Polycast: least-privilege application role for request handlers (RLS)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'polycast_app', dbname: 'polycast' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 40,
      },
    });

    // ---------------------------------------------------------------- alarms
    new cloudwatch.Alarm(this, 'CapacityNearMax', {
      alarmDescription: `Aurora capacity at or above 90% of ${maxCapacity} ACU for 15 minutes`,
      metric: this.cluster.metricServerlessDatabaseCapacity({
        period: cdk.Duration.minutes(1),
        statistic: 'Average',
      }),
      threshold: maxCapacity * 0.9,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 15,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'ConnectionsHigh', {
      alarmDescription: 'Aurora connections high; check API pool sizing (DATABASE_POOL_MAX)',
      metric: this.cluster.metricDatabaseConnections({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 200,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'ClusterPort', {
      value: cdk.Tokenization.stringifyNumber(this.cluster.clusterEndpoint.port),
    });
    new cdk.CfnOutput(this, 'OwnerSecretArn', { value: this.ownerSecret.secretArn });
    new cdk.CfnOutput(this, 'AppSecretArn', { value: this.appSecret.secretArn });
  }
}
