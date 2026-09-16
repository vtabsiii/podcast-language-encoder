import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { tagPolycastStack } from './polycast-common';

/**
 * Shared VPC for the Polycast control and media planes (architecture.md §2).
 *
 * Two AZs, one NAT gateway (dev cost; raise to one per AZ for production), an S3 gateway
 * endpoint and interface endpoints for everything the Fargate tasks and the rotation Lambda
 * talk to, so image pulls, logs, secrets and Step Functions callbacks never leave the VPC.
 * Flow logs go to CloudWatch for 30 days (retention map §10: logs never contain content).
 */
export class PolycastNetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    tagPolycastStack(this, 'network');

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.vpc.addFlowLog('VpcFlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    const interfaceEndpoints: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
      ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDocker', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['CloudWatchLogs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['Sts', ec2.InterfaceVpcEndpointAwsService.STS],
      ['Sqs', ec2.InterfaceVpcEndpointAwsService.SQS],
      ['StepFunctions', ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS],
    ];
    for (const [endpointId, service] of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(endpointId, {
        service,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: cdk.Fn.join(
        ',',
        this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      ),
      description: 'Pass to `aws ecs run-task --network-configuration` for the migration task',
    });
  }
}
