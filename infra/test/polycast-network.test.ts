import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildPolycastApp } from './polycast-fixture';

describe('PolycastNetworkStack', () => {
  const { network } = buildPolycastApp();
  const template = Template.fromStack(network);

  test('two-AZ VPC with public and private subnets and a single NAT gateway', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('S3 gateway endpoint plus the seven interface endpoints the tasks need', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith(['.s3'])]) }),
    });
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const interfaceServices = Object.values(endpoints)
      .filter((r) => r.Properties.VpcEndpointType === 'Interface')
      .map((r) => JSON.stringify(r.Properties.ServiceName));
    expect(interfaceServices).toHaveLength(7);
    for (const suffix of ['ecr.api', 'ecr.dkr', 'logs', 'secretsmanager', 'sts', 'sqs', 'states']) {
      expect(interfaceServices.some((s) => s.includes(`.${suffix}`))).toBe(true);
    }
  });

  test('flow logs go to CloudWatch with 30-day retention', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      LogDestinationType: 'cloud-watch-logs',
      TrafficType: 'ALL',
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  test('carries the cost allocation tags', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      // CloudFormation tags are rendered sorted by key.
      Tags: Match.arrayWith([
        { Key: 'polycast:service', Value: 'network' },
        { Key: 'polycast:stack', Value: 'PolycastNetwork' },
        { Key: 'project', Value: 'polycast' },
      ]),
    });
  });
});
