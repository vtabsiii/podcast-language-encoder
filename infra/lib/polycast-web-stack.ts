import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { tagPolycastStack } from './polycast-common';

export interface PolycastWebStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /** ECS cluster shared with the API stack. */
  cluster: ecs.ICluster;
  /** `http://<internal api alb dns>`; becomes API_BASE_URL for the Next.js server. */
  apiInternalUrl: string;
  /** Security group of the API's internal ALB; this stack adds the web tier's ingress rule. */
  apiLoadBalancerSecurityGroup: ec2.ISecurityGroup;
  /** Derived bucket (PolycastStorage) served under `/media/*` through signed URLs. */
  derivedBucketArn: string;
  derivedBucketName: string;
  /** ECR image tag to run; defaults to `latest`. */
  imageTag?: string;
  /**
   * PEM-encoded RSA public key for the CloudFront key group that signs `/media/*` URLs.
   * When omitted the `/media/*` behaviour is not created (see the `MediaBehavior` output).
   */
  cloudFrontPublicKeyPem?: string;
}

/** Header CloudFront adds on every origin request; the web ALB only forwards when it matches. */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

/**
 * `apps/web` (Next.js standalone) on ECS Fargate behind a PUBLIC application load balancer
 * that only CloudFront can use (ADR-0001, ADR-0006).
 *
 * CloudFront behaviours:
 * - default and `/api/*` -> web ALB (HTTPS-only viewers, all methods, no caching, all
 *   headers/cookies/query forwarded). The Next.js route handler proxies `/api/*` to the API's
 *   internal ALB, so the API is never exposed directly.
 * - `/_next/static/*`, `/assets/*` -> static assets bucket through an origin access control,
 *   cached for a year (immutable file names).
 * - `/media/*` -> derived bucket through an origin access control, restricted to a key group
 *   (present only when `cloudFrontPublicKeyPem` is given).
 *
 * The ALB listener's default action is 403; a single rule forwards requests that carry the
 * `X-Origin-Verify` header with the generated secret CloudFront attaches. No custom domain or
 * certificate: the distribution uses its `*.cloudfront.net` name and reaches the ALB over HTTP.
 */
export class PolycastWebStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly staticAssetsBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: PolycastWebStackProps) {
    super(scope, id, props);
    tagPolycastStack(this, 'web');

    const imageTag = props.imageTag ?? 'latest';

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'polycast/web',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: 'keep the last 20 images', maxImageCount: 20 }],
    });

    // ------------------------------------------------------------- service
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const container = taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(this.repository, imageTag),
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        NEXT_TELEMETRY_DISABLED: '1',
        API_BASE_URL: props.apiInternalUrl,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'web',
        logGroup: new logs.LogGroup(this, 'WebLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'Polycast web tasks',
      allowAllOutbound: true,
    });
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      serviceName: 'polycast-web',
      taskDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup],
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });
    // The web tier is the only public path to the API (remoteRule=true keeps the rule here).
    props.apiLoadBalancerSecurityGroup.addIngressRule(
      serviceSecurityGroup,
      ec2.Port.tcp(80),
      'Polycast web tier -> API internal ALB',
      true,
    );

    // ------------------------------------------------------ public ALB (CloudFront only)
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: `Polycast: value of the ${ORIGIN_VERIFY_HEADER} header CloudFront sends to the web ALB`,
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    // Resolved by CloudFormation at deploy time ({{resolve:secretsmanager:...}}); never in code.
    const originVerifyValue = originVerifySecret.secretValue.unsafeUnwrap();

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: cdk.Duration.seconds(300),
      dropInvalidHeaderFields: true,
    });
    const listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden',
      }),
    });
    listener.addTargets('Web', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originVerifyValue])],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service.loadBalancerTarget({ containerName: container.containerName })],
      healthCheck: {
        path: '/login', // exempt from the auth redirect in apps/web/middleware.ts
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200-399',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    this.service
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 })
      .scaleOnCpuUtilization('Cpu', {
        targetUtilizationPercent: 60,
      });

    // -------------------------------------------------------------- static assets
    this.staticAssetsBucket = new s3.Bucket(this, 'StaticAssets', {
      bucketName: `polycast-web-static-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------- CloudFront
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Polycast Studio security headers',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        // Next.js and Fastify set their own; media objects from S3 get no-referrer (T-02).
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: false,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
    });

    const webOrigin = new origins.LoadBalancerV2Origin(this.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerifyValue },
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });
    const dynamicBehavior: cloudfront.BehaviorOptions = {
      origin: webOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      responseHeadersPolicy,
      compress: true,
    };
    const staticBehavior: cloudfront.BehaviorOptions = {
      origin: origins.S3BucketOrigin.withOriginAccessControl(this.staticAssetsBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy,
      compress: true,
    };

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
      '/_next/static/*': staticBehavior,
      '/assets/*': staticBehavior,
      '/api/*': dynamicBehavior,
    };

    let mediaBehaviorNote =
      'disabled: pass context polycastCloudFrontPublicKeyPem to enable /media/*';
    if (props.cloudFrontPublicKeyPem) {
      const publicKey = new cloudfront.PublicKey(this, 'MediaSigningKey', {
        encodedKey: props.cloudFrontPublicKeyPem,
        comment: 'Polycast: verifies signed /media/* URLs minted by the API',
      });
      const keyGroup = new cloudfront.KeyGroup(this, 'MediaKeyGroup', { items: [publicKey] });
      // Imported reference: the bucket policy is owned by PolycastStorage (which admits every
      // distribution of this account), so CDK must not try to edit it from here.
      const derivedBucket = s3.Bucket.fromBucketAttributes(this, 'DerivedBucket', {
        bucketArn: props.derivedBucketArn,
        bucketName: props.derivedBucketName,
        region: this.region,
      });
      cdk.Annotations.of(this).acknowledgeWarning(
        '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicy',
        'PolycastStorage grants cloudfront.amazonaws.com read on the derived bucket and key',
      );
      additionalBehaviors['/media/*'] = {
        origin: origins.S3BucketOrigin.withOriginAccessControl(derivedBucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        trustedKeyGroups: [keyGroup],
        responseHeadersPolicy,
      };
      mediaBehaviorNote = `enabled: key group ${keyGroup.keyGroupId}, public key ${publicKey.publicKeyId}`;
      new cdk.CfnOutput(this, 'MediaPublicKeyId', {
        value: publicKey.publicKeyId,
        description: 'CloudFront key pair id the API uses to sign /media/* URLs',
      });
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Polycast Studio web',
      defaultBehavior: dynamicBehavior,
      additionalBehaviors,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // No custom certificate (default *.cloudfront.net domain), so minimumProtocolVersion
      // would be ignored; the default certificate's policy applies.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
    });

    // -------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'WebAlbDnsName', { value: this.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'StaticAssetsBucketName', {
      value: this.staticAssetsBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'WebRepositoryUri', { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, 'MediaBehavior', { value: mediaBehaviorNote });
  }
}
