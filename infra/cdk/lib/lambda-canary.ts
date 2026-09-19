import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export type LambdaDeploymentPreference = 'AllAtOnce' | 'Canary10Percent5Minutes';

/**
 * Turns a CDK `Function` into an `AWS::Serverless::Function` so we get SAM's
 * AutoPublishAlias / AutoPublishAliasAllProperties / DeploymentPreference
 * instead of a hand-rolled CodeDeploy `LambdaDeploymentGroup`.
 *
 * Traffic must go to the returned `:live` alias, not `$LATEST`.
 */
export function publishLiveAlias(
  fn: lambda.Function,
  preference: LambdaDeploymentPreference,
): lambda.IFunction {
  fn.stack.addTransform('AWS::Serverless-2016-10-31');

  const cfn = fn.node.defaultChild as lambda.CfnFunction;
  cfn.addOverride('Type', 'AWS::Serverless::Function');

  const imageUri = (cfn.code as lambda.CfnFunction.CodeProperty | undefined)?.imageUri;
  if (imageUri) {
    cfn.addPropertyOverride('ImageUri', imageUri);
    cfn.addPropertyDeletionOverride('Code');
  }

  cfn.addPropertyOverride('AutoPublishAlias', 'live');
  cfn.addPropertyOverride('AutoPublishAliasAllProperties', true);
  cfn.addPropertyOverride('DeploymentPreference', { Type: preference });

  return lambda.Function.fromFunctionAttributes(fn, 'LiveAlias', {
    functionArn: `${fn.functionArn}:live`,
    role: fn.role,
  });
}
