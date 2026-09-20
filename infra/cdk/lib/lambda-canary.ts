import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const ALIAS_NAME = 'current';
const CANARY_PERIOD = cdk.Duration.minutes(1);

export interface CurrentAliasOptions {
  /**
   * Traffic-shifting strategy for new versions. Omit for an immediate cutover:
   * the alias simply points at the new version and CloudFormation does not wait
   * on a CodeDeploy deployment.
   */
  canary?: codedeploy.ILambdaDeploymentConfig;
}

function errorAlarm(
  scope: lambda.Function,
  id: string,
  description: string,
  metric: cloudwatch.IMetric,
): cloudwatch.Alarm {
  return new cloudwatch.Alarm(scope, id, {
    alarmDescription: description,
    metric,
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}

/**
 * Publishes a `current` alias pointing at this deploy's version, and returns
 * it. Callers must send invoke traffic at the returned alias, not `$LATEST`,
 * or a canary never sees user traffic. Do not set `additionalVersions` on the
 * alias; CodeDeploy owns the weights during a shift.
 *
 * With `canary`, CodeDeploy shifts traffic per that config and rolls the alias
 * back if either alarm fires: Errors on the alias, or on the new version only
 * (an error on the old version must not fail a good deploy).
 */
export function publishCurrentAlias(
  fn: lambda.Function,
  options: CurrentAliasOptions = {},
): lambda.Alias {
  const alias = new lambda.Alias(fn, 'CurrentAlias', {
    aliasName: ALIAS_NAME,
    version: fn.currentVersion,
  });

  if (!options.canary) return alias;

  const aliasErrors = errorAlarm(
    fn,
    'CurrentAliasErrors',
    `${fn.node.path} ${ALIAS_NAME} alias Errors >= 1 — CodeDeploy rolls the canary back`,
    alias.metricErrors({ period: CANARY_PERIOD, statistic: 'sum' }),
  );

  const newVersionErrors = errorAlarm(
    fn,
    'CurrentVersionErrors',
    `${fn.node.path} new version Errors >= 1 — CodeDeploy rolls the canary back`,
    new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      statistic: 'sum',
      period: CANARY_PERIOD,
      dimensionsMap: {
        FunctionName: fn.functionName,
        Resource: `${fn.functionName}:${ALIAS_NAME}`,
        ExecutedVersion: fn.currentVersion.version,
      },
    }),
  );

  new codedeploy.LambdaDeploymentGroup(fn, 'Canary', {
    alias,
    deploymentConfig: options.canary,
    alarms: [aliasErrors, newVersionErrors],
  });

  return alias;
}
