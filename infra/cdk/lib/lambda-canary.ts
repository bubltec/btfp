import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sam from 'aws-cdk-lib/aws-sam';

const CANARY_PERIOD = cdk.Duration.minutes(1);

/**
 * Turns a CDK `Function` into an `AWS::Serverless::Function` so we get SAM's
 * AutoPublishAlias / AutoPublishAliasAllProperties / DeploymentPreference
 * instead of a hand-rolled CodeDeploy `LambdaDeploymentGroup`.
 *
 * `deploymentPreference` is SAM's `CfnFunction.DeploymentPreferenceProperty`.
 * `type` starts the traffic shift; `alarms` (if any) only roll it back.
 *
 * Traffic must go to the returned `:live` alias, not `$LATEST`.
 */
export function publishLiveAlias(
  fn: lambda.Function,
  deploymentPreference: sam.CfnFunction.DeploymentPreferenceProperty,
): lambda.IFunction {
  // PublishVersion fails with "A version for this Lambda function exists (N)"
  // when code+config match an already-published version. That is the usual
  // first-deploy of AutoPublishAlias onto a function that already has versions
  // from an earlier CDK `currentVersion` — the SAM Version resource is new to
  // the stack, but Lambda sees no change. This env var is the configuration
  // change that lets CreateVersion succeed; later deploys keep it.
  fn.addEnvironment('BTFP_INVOKE_ALIAS', 'live');

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

  const shifting = deploymentPreference.type && deploymentPreference.type !== 'AllAtOnce';
  let alarms = deploymentPreference.alarms;
  if (shifting && !alarms) {
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
    alarms = [aliasErrors.alarmName];
  }

  cfn.addPropertyOverride('DeploymentPreference', {
    Type: deploymentPreference.type,
    ...(alarms ? { Alarms: alarms } : {}),
    ...(deploymentPreference.enabled !== undefined
      ? { Enabled: deploymentPreference.enabled }
      : {}),
    ...(deploymentPreference.hooks ? { Hooks: deploymentPreference.hooks } : {}),
    ...(deploymentPreference.role ? { Role: deploymentPreference.role } : {}),
  });

  return lambda.Function.fromFunctionAttributes(fn, 'LiveAlias', {
    functionArn: `${fn.functionArn}:live`,
    role: fn.role,
  });
}
