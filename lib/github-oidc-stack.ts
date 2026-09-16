import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** GitHub user or organisation that owns the repository. */
  githubOwner: string;
  /** Repository name (without the owner). */
  githubRepo: string;
  /**
   * Git refs allowed to assume the deploy role. Defaults to the main branch,
   * pull requests, and any environment named "production".
   */
  allowedSubjects?: string[];
}

/**
 * Trust between GitHub Actions and this AWS account.
 *
 * Deploy this stack ONCE (from CloudShell or a laptop with admin credentials),
 * then put the emitted role ARN into the repository variable AWS_DEPLOY_ROLE_ARN.
 * After that, GitHub Actions never needs a stored AWS access key.
 */
export class GithubOidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

  const repoPath = `${props.githubOwner}/${props.githubRepo}`;

  // Newer GitHub OIDC tokens spell the subject as `repo:owner@<id>/repo@<id>:...`
  // rather than `repo:owner/repo:...`. The numeric IDs are immutable, so trust
  // both spellings exactly (no wildcards). IDs come from cdk.json context
  // (`githubOwnerId`, `githubRepoId`); look them up with
  // `gh api users/<owner>` and `gh api repos/<owner>/<repo>`.
  const ownerId = this.node.tryGetContext('githubOwnerId') as string | number | undefined;
  const repoId = this.node.tryGetContext('githubRepoId') as string | number | undefined;
  const repoPaths = [repoPath];
  if (ownerId && repoId) {
    repoPaths.push(`${props.githubOwner}@${ownerId}/${props.githubRepo}@${repoId}`);
  }
  const subjects =
    props.allowedSubjects ??
    repoPaths.flatMap((p) => [
      `repo:${p}:ref:refs/heads/main`,
      `repo:${p}:pull_request`,
      `repo:${p}:environment:production`,
    ]);

    // An account can only hold one provider for token.actions.githubusercontent.com.
    // If one already exists, pass its ARN via context `githubOidcProviderArn`.
    const existingProviderArn = this.node.tryGetContext('githubOidcProviderArn') as string | undefined;
    const provider = existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubProvider', existingProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GithubProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `${props.githubRepo}-github-deploy`,
      description: `Assumed by GitHub Actions in ${repoPath} to run cdk deploy`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': subjects,
        },
      }),
    });

    // CDK deploys through the bootstrap roles; the GitHub role only needs to assume them.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCdkBootstrapVersion',
        actions: ['ssm:GetParameter'],
        resources: [`arn:${this.partition}:ssm:*:${this.account}:parameter/cdk-bootstrap/*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Set this as the GitHub repository variable AWS_DEPLOY_ROLE_ARN',
    });
    new cdk.CfnOutput(this, 'OidcProviderArn', {
      value: provider.openIdConnectProviderArn,
    });
  }
}
