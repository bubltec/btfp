import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const CANARY_PERIOD = cdk.Duration.minutes(1);

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
 * SAM's AutoPublishAlias + DeploymentPreference, as CDK L2:
 * publish a `live` alias on every function change, shift 10% of traffic for
 * 5 minutes, then the rest — and roll the alias back if Errors >= 1 on
 * either the alias or the new version.
 *
 * Callers must send invoke traffic at the returned alias, not `$LATEST`,
 * or CodeDeploy's shift is a no-op for users. Do not set
 * `additionalVersions` on the alias; CodeDeploy owns the weights.
 */
export function publishLiveAliasWithCanary(fn: lambda.Function): lambda.Alias {
  const alias = fn.addAlias('live');

  const aliasErrors = errorAlarm(
    fn,
    'LiveAliasErrors',
    `${fn.node.path} live alias Errors >= 1 — CodeDeploy rolls the canary back`,
    alias.metricErrors({ period: CANARY_PERIOD, statistic: 'sum' }),
  );

  // SAM's LatestVersionErrorMetricGreaterThanZeroAlarm: only the version
  // currently being canaried, invoked through the live alias. An error on
  // the old version must not fail a good deploy.
  const newVersionErrors = errorAlarm(
    fn,
    'LiveVersionErrors',
    `${fn.node.path} new version Errors >= 1 — CodeDeploy rolls the canary back`,
    new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      statistic: 'sum',
      period: CANARY_PERIOD,
      dimensionsMap: {
        FunctionName: fn.functionName,
        Resource: `${fn.functionName}:live`,
        ExecutedVersion: fn.currentVersion.version,
      },
    }),
  );

  new codedeploy.LambdaDeploymentGroup(fn, 'Canary', {
    alias,
    deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
    alarms: [aliasErrors, newVersionErrors],
  });

  return alias;
}
