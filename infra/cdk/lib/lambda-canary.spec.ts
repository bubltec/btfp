import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { publishCurrentAlias } from './lambda-canary.js';

function synth(options?: Parameters<typeof publishCurrentAlias>[1]): Template {
  const stack = new cdk.Stack(new cdk.App(), 'Test');
  const fn = new lambda.Function(stack, 'Fn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
  });
  publishCurrentAlias(fn, options);
  return Template.fromStack(stack);
}

describe('publishCurrentAlias', () => {
  it('without a canary: publishes the alias, no CodeDeploy, no SAM transform', () => {
    const template = synth();

    template.hasResourceProperties('AWS::Lambda::Alias', { Name: 'current' });
    template.resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    expect(template.toJSON().Transform).toBeUndefined();
  });

  it('with a canary: shifts traffic via CodeDeploy and rolls back on either alarm', () => {
    const template = synth({
      canary: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
    });

    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaCanary10Percent5Minutes',
      AlarmConfiguration: Match.objectLike({ Enabled: true }),
      AutoRollbackConfiguration: Match.objectLike({ Enabled: true }),
    });
    const [group] = Object.values(template.findResources('AWS::CodeDeploy::DeploymentGroup'));
    expect(group?.Properties.AlarmConfiguration.Alarms).toHaveLength(2);
    template.hasResource('AWS::Lambda::Alias', {
      UpdatePolicy: { CodeDeployLambdaAliasUpdate: Match.objectLike({}) },
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    expect(template.toJSON().Transform).toBeUndefined();
  });

  it('scopes the new-version alarm to the executed version, not the whole alias', () => {
    const template = synth({
      canary: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Dimensions: Match.arrayWith([Match.objectLike({ Name: 'ExecutedVersion' })]),
    });
  });
});
