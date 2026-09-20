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
 *
 * One-time migration note: a function that previously used a CDK-managed
 * `fn.addAlias('live')` (pre-SAM) has an existing `live` alias outside this
 * stack's control. SAM's `AutoPublishAlias` cannot create it while it
 * exists — CloudFormation has no reliable way to order that deletion
 * before this creation without a Ref-based custom resource depending on
 * the function, which cycles back through SAM's DependsOn propagation to
 * every resource generated from it (Version, Alias). Delete it manually,
 * once, before deploying this change:
 *   aws lambda delete-alias --function-name <physical-function-name> --name live
 * Safe to run against a function with no alias (returns ResourceNotFoundException).
 * See docs/infra.md.
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
    // Without this, CDK treats the imported alias as possibly
    // cross-account/region (fn.functionArn is a token) and silently no-ops
    // addPermission() — grantInvoke() from HttpLambdaIntegration then adds
    // no resource policy at all, so API Gateway gets 500s invoking it.
    // It's always the same stack's own function, just via an alias ARN.
    sameEnvironment: true,
  });
}
