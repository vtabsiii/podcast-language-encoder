import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import * as path from 'path';

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

/** Repository root: the Docker build context of every Polycast image. */
export const POLYCAST_REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Paths that never influence an image and are left out of its asset hash, so a docs or
 * infra change does not rebuild and redeploy the three services. `.dockerignore` at the
 * repository root already drops node_modules, build output and secrets.
 */
export const POLYCAST_IMAGE_EXCLUDES = ['.github', 'docs', 'infra', '**/*.md'];

/**
 * A service image built from one of the repository's Dockerfiles and published by
 * `cdk deploy` into the CDK bootstrap ECR repository (the GitHub OIDC role can already assume
 * the bootstrap image-publishing role, so no application-owned registry or manual
 * `docker push` is needed). Images are built for linux/amd64 to match the Fargate tasks.
 */
export function polycastContainerImage(
  scope: Construct,
  id: string,
  dockerfile: 'apps/api/Dockerfile' | 'apps/web/Dockerfile' | 'services/media-worker/Dockerfile',
): ecs.ContainerImage {
  return ecs.ContainerImage.fromDockerImageAsset(
    new ecrAssets.DockerImageAsset(scope, id, {
      directory: POLYCAST_REPO_ROOT,
      file: dockerfile,
      platform: ecrAssets.Platform.LINUX_AMD64,
      exclude: POLYCAST_IMAGE_EXCLUDES,
      ignoreMode: cdk.IgnoreMode.DOCKER,
    }),
  );
}
