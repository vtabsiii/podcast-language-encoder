import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildPolycastApp } from './polycast-fixture';

describe('PolycastDataStack', () => {
  const { data } = buildPolycastApp();
  const template = Template.fromStack(data);

  test('Aurora PostgreSQL Serverless v2 between 0.5 and 4 ACU with 35-day backups', () => {
    template.hasResource('AWS::RDS::DBCluster', {
      Properties: Match.objectLike({
        Engine: 'aurora-postgresql',
        EngineVersion: Match.stringLikeRegexp('^16\\.'),
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
        BackupRetentionPeriod: 35,
        DeletionProtection: true,
        StorageEncrypted: true,
        KmsKeyId: Match.anyValue(),
        DatabaseName: 'polycast',
        MasterUsername: 'polycast',
        MasterUserPassword: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      }),
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
    });
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.serverless',
      PubliclyAccessible: false,
    });
  });

  test('cluster parameter group forces TLS', () => {
    template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Parameters: { 'rds.force_ssl': '1' },
    });
  });

  test('owner secret rotates every 30 days and the app role has its own secret', () => {
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: { ScheduleExpression: 'rate(30 days)' },
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: Match.stringLikeRegexp('"username":"polycast_app"'),
        GenerateStringKey: 'password',
        ExcludePunctuation: true,
      }),
    });
  });

  test('alarms on capacity near the maximum and on connection count', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ServerlessDatabaseCapacity',
      Threshold: 3.6,
      EvaluationPeriods: 15,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'DatabaseConnections',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('exports the endpoint and both secrets', () => {
    template.hasOutput('ClusterEndpoint', {});
    template.hasOutput('OwnerSecretArn', {});
    template.hasOutput('AppSecretArn', {});
    // Transitional: the replaced secret keeps its cross-stack export until PolycastApi has
    // switched to AppSecretV2 (CloudFormation refuses to delete an export that is in use).
    template.resourceCountIs('AWS::SecretsManager::Secret', 3); // owner, legacy app, AppSecretV2
    const outputs = Template.fromStack(data).toJSON().Outputs as Record<
      string,
      { Export?: { Name: unknown } }
    >;
    const legacyExport = Object.entries(outputs).find(([key]) =>
      /^ExportsOutputRefAppSecret[0-9A-F]+$/.test(key),
    );
    expect(legacyExport).toBeDefined();
  });
});
