/**
 * GitHub Actions → AWS without stored keys. Deploy once from a laptop (`npm run deploy:ci` in infra/);
 * after that, .github/workflows/deploy.yml assumes this role through GitHub's OIDC token.
 *
 * The role can only assume the CDK bootstrap roles (cdk-*), so it can do exactly what `cdk deploy` does,
 * and only from the configured repo and branch.
 */
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface CiStackProps extends StackProps {
  /** owner/name */
  githubRepo: string;
  githubBranch: string;
  /** If the account already has GitHub's OIDC provider (only one is allowed per account). */
  existingOidcProviderArn?: string;
  /**
   * Numeric GitHub IDs of the owner and repo. GitHub's token subject can carry them
   * ("repo:owner@123/name@456:ref:..."), and they never change even if the repo is renamed or transferred.
   */
  githubOwnerId?: string;
  githubRepoId?: string;
}

export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, "GitHub", props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, "GitHub", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });

    const ref = `ref:refs/heads/${props.githubBranch}`;
    const subjects = [`repo:${props.githubRepo}:${ref}`];
    if (props.githubOwnerId && props.githubRepoId) {
      const [owner, name] = props.githubRepo.split("/");
      subjects.push(`repo:${owner}@${props.githubOwnerId}/${name}@${props.githubRepoId}:${ref}`);
    }

    const role = new iam.Role(this, "DeployRole", {
      roleName: "margin-github-deploy",
      description: `cdk deploy from ${props.githubRepo}@${props.githubBranch}`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          // Either subject format, but only this repo and branch.
          "token.actions.githubusercontent.com:sub": subjects,
        },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", { value: role.roleArn, description: "Set as AWS_DEPLOY_ROLE_ARN in the GitHub repo's variables" });
  }
}
