import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export type LambdaDeploymentPreference = 'AllAtOnce' | 'Canary10Percent5Minutes';

const CANARY_PERIOD = cdk.Duration.minutes(1);

/**
 * Turns a CDK `Function` into an `AWS::Serverless::Function` so we get SAM's
 * AutoPublishAlias / AutoPublishAliasAllProperties / DeploymentPreference
 * instead of a hand-rolled CodeDeploy `LambdaDeploymentGroup`.
 *
 * `DeploymentPreference.Type` is what *starts* the traffic shift. The
 * CloudWatch alarm is only wired on canary deploys, and only to *roll back*
 * if `Errors >= 1` on the `live` alias during that window.
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

  const deploymentPreference: { Type: LambdaDeploymentPreference; Alarms?: string[] } = {
    Type: preference,
  };

  if (preference === 'Canary10Percent5Minutes') {
    const aliasErrors = new cloudwatch.Alarm(fn, 'LiveAliasErrors', {
      alarmDescription: `${fn.node.path} live alias Errors >= 1 — SAM rolls the canary back`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        statistic: 'sum',
        period: CANARY_PERIOD,
        dimensionsMap: {
          FunctionName: fn.functionName,
          Resource: `${fn.functionName}:live`,
        },
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    deploymentPreference.Alarms = [aliasErrors.alarmName];
  }

  cfn.addPropertyOverride('DeploymentPreference', deploymentPreference);

  return lambda.Function.fromFunctionAttributes(fn, 'LiveAlias', {
    functionArn: `${fn.functionArn}:live`,
    role: fn.role,
  });
}
