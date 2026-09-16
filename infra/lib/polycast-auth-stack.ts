import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import { tagPolycastStack } from './polycast-common';

export interface PolycastAuthStackProps extends cdk.StackProps {
  /** Cognito hosted UI domain prefix (`https://<prefix>.auth.<region>.amazoncognito.com`). */
  domainPrefix: string;
  /** Web origins used for OAuth callback/logout URLs. Defaults to the local web origin. */
  webOrigins?: string[];
}

/**
 * Cognito user pool for Polycast Studio (assumption A-14).
 *
 * Users are invited by an administrator (self sign-up off) and sign in by email. Membership is
 * carried on the user as `custom:org_ids` (space-separated organization ids) and `custom:role`;
 * the pre-token-generation trigger turns them into the `org_ids` (JSON array) and `role` claims
 * the API expects, alongside `email` and `name`. The pool is RETAIN with deletion protection:
 * it holds the identities of every tenant.
 */
export class PolycastAuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: PolycastAuthStackProps) {
    super(scope, id, props);
    tagPolycastStack(this, 'auth');

    const webOrigins = props.webOrigins ?? ['http://localhost:3000'];

    const preTokenGeneration = new NodejsFunction(this, 'PreTokenGenerationFn', {
      entry: path.join(__dirname, '..', 'lambda', 'pre-token-generation', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      description: 'Polycast: copy custom:org_ids / custom:role into token claims',
      logGroup: new logs.LogGroup(this, 'PreTokenGenerationLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'polycast',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        org_ids: new cognito.StringAttribute({ minLen: 0, maxLen: 2048, mutable: true }),
        role: new cognito.StringAttribute({ minLen: 0, maxLen: 64, mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: { preTokenGeneration },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'polycast-web',
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: webOrigins.map((origin) => `${origin}/auth/callback`),
        logoutUrls: webOrigins.map((origin) => `${origin}/logout/done`),
      },
    });

    this.userPoolDomain = this.userPool.addDomain('HostedUi', {
      cognitoDomain: { domainPrefix: props.domainPrefix },
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'HostedUiUrl', { value: this.userPoolDomain.baseUrl() });
  }
}
