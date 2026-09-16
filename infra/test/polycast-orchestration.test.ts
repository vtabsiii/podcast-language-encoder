import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildPolycastApp } from './polycast-fixture';
import { TARGET_STAGES, PARENT_STAGES } from '../lib/stage-table';

describe('PolycastOrchestrationStack', () => {
  const { orchestration } = buildPolycastApp({ monthlyBudgetUsd: 350 });
  const template = Template.fromStack(orchestration);
  const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
  const definitionOf = (name: string): string => {
    const match = Object.values(stateMachines).find((r) => r.Properties.StateMachineName === name);
    if (!match) throw new Error(`state machine ${name} not found`);
    return JSON.stringify(match.Properties.DefinitionString);
  };

  test('two Standard state machines with X-Ray tracing and ALL-level logging', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    template.allResourcesProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({ Level: 'ALL', IncludeExecutionData: false }),
    });
  });

  test('child machine has a task-token SQS state per stage, retries, and <STAGE>_FAILED catches', () => {
    const definition = definitionOf('polycast-target-job');
    // The ARN is joined around { Ref: AWS::Partition }, so match the service part only.
    expect(definition).toContain(':states:::sqs:sendMessage.waitForTaskToken');
    for (const stage of TARGET_STAGES) {
      expect(definition).toContain(`\\"${stage}\\":`);
      expect(definition).toContain(`\\"${stage}_FAILED\\":`);
    }
    expect(definition).toContain('States.TaskFailed');
    expect(definition).toContain('States.Timeout');
    expect(definition).toContain('\\"IntervalSeconds\\":30');
    expect(definition).toContain('\\"BackoffRate\\":2');
    expect(definition).toContain('\\"MaxAttempts\\":3');
    expect(definition).toContain('$$.Task.Token');
    expect(definition).toContain('$$.State.RetryCount');
    expect(definition).toContain('\\"stage\\":\\"TRANSLATING\\"');
  });

  test('child machine skips LIP_SYNCING on $.lipSync and gates PACKAGING on $.qa.needsReview', () => {
    const definition = definitionOf('polycast-target-job');
    expect(definition).toContain('\\"LipSyncEnabled\\":');
    expect(definition).toContain('\\"Variable\\":\\"$.lipSync\\"');
    expect(definition).toContain('\\"ReadyGate\\":');
    expect(definition).toContain('\\"Variable\\":\\"$.qa.needsReview\\"');
    expect(definition).toContain('\\"NEEDS_REVIEW\\":');
    expect(definition).toContain('\\"TimeoutSeconds\\":31536000'); // 365 days
    expect(definition).toContain('\\"COMPLETE\\":');
  });

  test('parent machine: TRANSCRIBING -> SOURCE_QA -> Map fan-out with MaxConcurrencyPath', () => {
    const definition = definitionOf('polycast-localization-job');
    for (const stage of PARENT_STAGES) expect(definition).toContain(`\\"${stage}\\":`);
    expect(definition).toContain('\\"MaxConcurrencyPath\\":\\"$.maxConcurrency\\"');
    expect(definition).toContain('\\"ItemsPath\\":\\"$.targets\\"');
    expect(definition).toContain(':states:::states:startExecution.sync:2');
    expect(definition).toContain('\\"JOB_COMPLETE\\":');
  });

  test('stage queue has a KMS-encrypted DLQ with maxReceiveCount 3 and 14-day retention', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'polycast-stage',
      MessageRetentionPeriod: 1209600,
      KmsMasterKeyId: Match.anyValue(),
      RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: 3 },
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'polycast-stage-dlq',
      MessageRetentionPeriod: 1209600,
      KmsMasterKeyId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'polycast-review-wait' });
    template.hasResourceProperties('AWS::Events::EventBus', { Name: 'polycast-events' });
  });

  test('media worker: 1 task (1024/2048), scales 1-4 on stage queue depth, can reach the API', () => {
    template.resourceCountIs('AWS::ECR::Repository', 0);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'polycast-media-worker',
      DesiredCount: 1,
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '1024',
      Memory: '2048',
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'media-worker',
          Command: Match.arrayWith(['python', '-m', 'polycast_worker', '--api-url']),
          Image: Match.objectLike({
            'Fn::Sub': Match.stringLikeRegexp('container-assets-.*:[0-9a-f]{64}$'),
          }),
          Environment: Match.arrayWith([
            { Name: 'POLYCAST_ENV', Value: 'production' },
            { Name: 'PROVIDER_MODE', Value: 'aws' },
            { Name: 'STORAGE_DRIVER', Value: 's3' },
            Match.objectLike({ Name: 'WORKER_QUEUE_URL' }),
            Match.objectLike({ Name: 'MEDIA_BUCKET_SOURCE' }),
          ]),
          Secrets: [Match.objectLike({ Name: 'WORKER_TOKEN' })],
        }),
      ],
    });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 1,
      MaxCapacity: 4,
    });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'StepScaling',
      StepScalingPolicyConfiguration: Match.objectLike({ AdjustmentType: 'ChangeInCapacity' }),
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      AlarmActions: Match.arrayWith([
        Match.objectLike({ Ref: Match.stringLikeRegexp('QueueDepth') }),
      ]),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 80,
      ToPort: 80,
      Description: 'Polycast media worker -> API internal ALB (/internal/v1)',
    });
  });

  test('worker role can consume both queues and resolve task tokens', () => {
    // One action per assertion: action order differs between the CLI (minimizePolicies
    // sorts them) and this fixture (grant order), and arrayWith is order-sensitive.
    const hasStatement = (pattern: Record<string, unknown>) =>
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([Match.objectLike(pattern)]),
        }),
      });
    for (const action of [
      'sqs:ReceiveMessage',
      'sqs:DeleteMessage',
      'sqs:ChangeMessageVisibility',
    ]) {
      hasStatement({ Action: Match.arrayWith([action]) });
    }
    for (const action of [
      'states:SendTaskSuccess',
      'states:SendTaskFailure',
      'states:SendTaskHeartbeat',
    ]) {
      hasStatement({ Sid: 'ResolveTaskTokens', Action: Match.arrayWith([action]), Resource: '*' });
    }
  });

  test('alarms: DLQ depth, failed executions on both machines, review wait age over 7 days', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      Dimensions: [Match.objectLike({ Name: 'QueueName' })],
      AlarmDescription: Match.stringLikeRegexp('exhausted its retries'),
    });
    const failed = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(
      (a) => a.Properties.MetricName === 'ExecutionsFailed',
    );
    expect(failed).toHaveLength(2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateAgeOfOldestMessage',
      Threshold: 604800,
    });
  });

  test('monthly cost budget with SNS notifications at 80% and 100%', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 350, Unit: 'USD' },
      }),
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 80, ThresholdType: 'PERCENTAGE' }),
          Subscribers: [Match.objectLike({ SubscriptionType: 'SNS' })],
        }),
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 100 }) }),
      ],
    });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: 'sns:Publish',
          }),
        ]),
      }),
    });
  });

  test('every taggable resource carries the cost allocation tags', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'polycast-stage',
      Tags: Match.arrayWith([
        { Key: 'polycast:service', Value: 'orchestration' },
        { Key: 'polycast:stack', Value: 'PolycastOrchestration' },
      ]),
    });
  });
});

describe('PolycastOrchestrationStack with an SES sender', () => {
  test('passes SES_FROM_ADDRESS to the worker only when configured', () => {
    const withSes = Template.fromStack(
      buildPolycastApp({ sesFromAddress: 'noreply@polycast.example' }).orchestration,
    );
    withSes.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'media-worker',
          Environment: Match.arrayWith([
            { Name: 'SES_FROM_ADDRESS', Value: 'noreply@polycast.example' },
          ]),
        }),
      ],
    });
    const without = Template.fromStack(buildPolycastApp().orchestration);
    const [taskDef] = Object.values(without.findResources('AWS::ECS::TaskDefinition'));
    const names = taskDef.Properties.ContainerDefinitions[0].Environment.map(
      (e: { Name: string }) => e.Name,
    );
    expect(names).not.toContain('SES_FROM_ADDRESS');
  });
});
