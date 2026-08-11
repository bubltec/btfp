import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AWS_REGION, GITHUB_REPO } from './config.js';

const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';

/**
 * Deployed once, standalone (like BtfpDns/BtfpEmail) — not per-stage.
 *
 * One IAM role GitHub Actions assumes via OIDC to run `cdk deploy`. Imports
 * the account's existing `token.actions.githubusercontent.com` OIDC
 * provider (registered previously by an unrelated project) rather than
 * creating a new one — IAM only allows one per URL per account, so
 * constructing a second would fail as a duplicate.
 *
 * The role itself carries no direct AWS permissions beyond `sts:AssumeRole`
 * on the four CDK bootstrap roles the `cdk` CLI calls directly (deploy,
 * file-publishing, image-publishing, lookup — not cfn-exec, which
 * deploy-role assumes internally). Every actual resource mutation happens
 * through those already-scoped bootstrap roles, not this role's own
 * policy — see docs/ci-cd.md for why this is the right minimal-surface
 * pattern, and why branch protection on `main` is load-bearing here (not
 * optional): cfn-exec-role carries AdministratorAccess by default, so this
 * role's effective blast radius is full account admin, gated only by the
 * `sub` claim condition below matching pushes to `main`.
 */
export class CiStack extends cdk.Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidc',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    this.deployRole = new iam.Role(this, 'GhaDeployRole', {
      roleName: 'btfp-gha-deploy',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // Only workflow runs that are actual pushes to `main` can assume
        // this role — PR-triggered runs get no AWS credentials at all, by
        // construction. The GitHub Environment protection rule on the
        // prod-deploy job (see docs/ci-cd.md) is the actual human-approval
        // gate for prod; this condition just keeps arbitrary branches out
        // entirely.
        //
        // Two patterns, not one: GitHub's sub claim format changes when a
        // job specifies `environment:` — it becomes
        // `repo:.../...:environment:<name>` instead of the ref-based form,
        // regardless of what ref triggered it. deploy-dev/prod-diff (no
        // `environment:`) send the ref form; deploy-prod (`environment:
        // production`) sends the environment form. Confirmed empirically
        // (deploy-prod failed assume-role with only the ref pattern
        // present) rather than assumed from docs.
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${GITHUB_REPO}:ref:refs/heads/main`,
            `repo:${GITHUB_REPO}:environment:production`,
          ],
        },
      }),
    });

    for (const bootstrapRole of [
      'deploy-role',
      'file-publishing-role',
      'image-publishing-role',
      'lookup-role',
    ]) {
      this.deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::${this.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${bootstrapRole}-${this.account}-${AWS_REGION}`,
          ],
        }),
      );
    }

    // One deliberate, narrow exception to "no direct permissions beyond
    // assume-role" above: `deploy-prod`'s seed step (data/seed/src/run.ts)
    // writes reference content (breeds, curated hazards, plant/food data)
    // directly via the SDK, not through `cdk deploy` — so it needs its own
    // grant rather than riding the bootstrap roles' CloudFormation-exec
    // permissions. Scoped to exactly the one table and the one action the
    // script performs (BatchWriteItem — it never reads or deletes).
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:BatchWriteItem'],
        resources: [`arn:aws:dynamodb:${AWS_REGION}:${this.account}:table/btfp-prod-content`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn });
  }
}
