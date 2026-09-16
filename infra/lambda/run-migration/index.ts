/**
 * CloudFormation custom resource (Provider framework) that runs the Polycast database
 * migration as a one-off ECS Fargate task and waits for it to finish.
 *
 * `onEvent` starts the task on Create/Update and does nothing on Delete; `isComplete` polls
 * the task until it stops and fails the resource when the container exits non-zero, so a
 * broken migration rolls the stack back before the API service picks up the new image. The
 * resource properties include the task definition ARN, which changes with every revision
 * (new image, new environment), so each deploy that ships a change re-runs the migration.
 *
 * Runs on the Node 22 runtime, which bundles the AWS SDK v3; nothing is packaged with it.
 * Logs never contain secrets: only ARNs, statuses and exit codes are printed.
 */
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTasksCommand, ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

interface ResourceProperties {
  readonly ClusterArn: string;
  readonly TaskDefinitionArn: string;
  readonly SubnetIds: string[];
  readonly SecurityGroupIds: string[];
  readonly ContainerName: string;
  /** awslogs group and stream prefix of the container, for the failure message. */
  readonly LogGroupName?: string;
  readonly LogStreamPrefix?: string;
  /** Opaque; changing it forces a new run (e.g. a deploy counter). */
  readonly RunKey?: string;
}

interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: ResourceProperties & { ServiceToken: string };
}

interface OnEventResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

interface IsCompleteRequest extends OnEventRequest {
  readonly PhysicalResourceId: string;
}

interface IsCompleteResponse {
  IsComplete: boolean;
  Data?: Record<string, string>;
}

const ecs = new ECSClient({});
const logs = new CloudWatchLogsClient({});

/** Last lines the migration container wrote (awslogs stream `<prefix>/<container>/<task id>`). */
async function logTail(props: ResourceProperties, taskArn: string): Promise<string> {
  if (!props.LogGroupName || !props.LogStreamPrefix) return '';
  const taskId = taskArn.split('/').pop() ?? '';
  try {
    const out = await logs.send(
      new GetLogEventsCommand({
        logGroupName: props.LogGroupName,
        logStreamName: `${props.LogStreamPrefix}/${props.ContainerName}/${taskId}`,
        limit: 30,
        startFromHead: false,
      }),
    );
    const text = (out.events ?? [])
      .map((e) => (e.message ?? '').trimEnd())
      .filter(Boolean)
      .join('\n');
    return text.length > 1500 ? `…${text.slice(-1500)}` : text;
  } catch (err) {
    return `(log tail unavailable: ${(err as Error).message})`;
  }
}

export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? 'polycast-migration-none' };
  }
  const props = event.ResourceProperties;
  const result = await ecs.send(
    new RunTaskCommand({
      cluster: props.ClusterArn,
      taskDefinition: props.TaskDefinitionArn,
      launchType: 'FARGATE',
      count: 1,
      startedBy: 'polycast-migration',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: props.SubnetIds,
          securityGroups: props.SecurityGroupIds,
          assignPublicIp: 'DISABLED',
        },
      },
    }),
  );
  const failure = result.failures?.[0];
  if (failure) {
    throw new Error(`RunTask failed: ${failure.reason ?? 'unknown'} (${failure.arn ?? ''})`);
  }
  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error('RunTask returned no task');
  console.log(`started migration task ${taskArn}`);
  return { PhysicalResourceId: taskArn, Data: { TaskArn: taskArn } };
}

export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  if (event.RequestType === 'Delete') return { IsComplete: true };
  const taskArn = event.PhysicalResourceId;
  const props = event.ResourceProperties;
  const described = await ecs.send(
    new DescribeTasksCommand({ cluster: props.ClusterArn, tasks: [taskArn] }),
  );
  const task = described.tasks?.[0];
  if (!task) {
    // ECS keeps stopped tasks for about an hour; a missing task is a hard failure.
    throw new Error(`migration task ${taskArn} not found`);
  }
  console.log(`migration task ${taskArn}: ${task.lastStatus ?? 'unknown'}`);
  if (task.lastStatus !== 'STOPPED') return { IsComplete: false };
  const container = task.containers?.find((c) => c.name === props.ContainerName);
  const exitCode = container?.exitCode;
  if (exitCode !== 0) {
    const tail = await logTail(props, taskArn);
    throw new Error(
      `migration task ${taskArn} exited with ${exitCode ?? 'no exit code'}: ${
        task.stoppedReason ?? container?.reason ?? 'see the migrate log stream'
      }${tail ? `\n--- log tail ---\n${tail}` : ''}`,
    );
  }
  return { IsComplete: true, Data: { TaskArn: taskArn } };
}
