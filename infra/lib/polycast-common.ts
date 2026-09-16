import * as cdk from 'aws-cdk-lib';

/**
 * Names shared between Polycast stacks that must not reference each other directly.
 *
 * `PolycastApi` grants `states:*` on state machines matching `POLYCAST_STATE_MACHINE_PREFIX*`
 * and `events:PutEvents` on the bus by name, so it does not depend on `PolycastOrchestration`
 * (which in turn depends on the API for the worker token and the internal ALB URL). A
 * CloudFormation dependency cycle is impossible that way.
 */
export const POLYCAST_EVENT_BUS_NAME = 'polycast-events';
export const POLYCAST_STATE_MACHINE_PREFIX = 'polycast-';
export const POLYCAST_PARENT_STATE_MACHINE_NAME = `${POLYCAST_STATE_MACHINE_PREFIX}localization-job`;
export const POLYCAST_CHILD_STATE_MACHINE_NAME = `${POLYCAST_STATE_MACHINE_PREFIX}target-job`;

/**
 * Cost allocation tags (NFR-012). Applied to every taggable resource in the stack; activate
 * `polycast:service` and `polycast:stack` as cost allocation tags in Billing once.
 */
export function tagPolycastStack(stack: cdk.Stack, service: string): void {
  cdk.Tags.of(stack).add('project', 'polycast');
  cdk.Tags.of(stack).add('service', service);
  cdk.Tags.of(stack).add('polycast:service', service);
  cdk.Tags.of(stack).add('polycast:stack', stack.stackName);
}

/** ARN of a state machine whose name starts with the Polycast prefix, for IAM patterns. */
export function polycastStateMachineArnPattern(stack: cdk.Stack): string {
  return stack.formatArn({
    service: 'states',
    resource: 'stateMachine',
    resourceName: `${POLYCAST_STATE_MACHINE_PREFIX}*`,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** ARN of any execution of a Polycast state machine, for IAM patterns. */
export function polycastExecutionArnPattern(stack: cdk.Stack): string {
  return stack.formatArn({
    service: 'states',
    resource: 'execution',
    resourceName: `${POLYCAST_STATE_MACHINE_PREFIX}*:*`,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

export function polycastStateMachineArn(stack: cdk.Stack, name: string): string {
  return stack.formatArn({
    service: 'states',
    resource: 'stateMachine',
    resourceName: name,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

export function polycastEventBusArn(stack: cdk.Stack): string {
  return stack.formatArn({
    service: 'events',
    resource: 'event-bus',
    resourceName: POLYCAST_EVENT_BUS_NAME,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}
