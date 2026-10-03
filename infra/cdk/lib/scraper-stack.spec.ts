import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { describe, expect, it } from 'vitest';
import { environments } from './config.js';
import { ScraperStack } from './scraper-stack.js';

function synth(envName: 'dev' | 'prod'): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const data = new cdk.Stack(app, 'Data', { env });
  const contentTable = new dynamodb.Table(data, 'Content', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  });
  const stack = new ScraperStack(app, 'Scraper', {
    env,
    envConfig: environments[envName],
    contentTable,
  });
  return Template.fromStack(stack);
}

function containerEnv(template: Template): Record<string, unknown> {
  const [taskDef] = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const entries = taskDef?.Properties.ContainerDefinitions[0].Environment as {
    Name: string;
    Value: unknown;
  }[];
  return Object.fromEntries(entries.map((entry) => [entry.Name, entry.Value]));
}

describe('ScraperStack', () => {
  it('prod runs once a week, on the 7-day trend list', () => {
    const template = synth('prod');
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 14 ? * MON *)',
    });
    expect(containerEnv(template)).toMatchObject({
      TRENDS_HOURS: '168',
      MAX_TOPICS_PER_RUN: '24',
      MAX_IDEAS_PER_RUN: '8',
    });
  });

  it('dev has no schedule and is started by hand', () => {
    const template = synth('dev');
    template.resourceCountIs('AWS::Events::Rule', 0);
    template.hasOutput('PublicSubnetIds', {});
    expect(containerEnv(template)).toMatchObject({ TRENDS_HOURS: '24', MAX_TOPICS_PER_RUN: '8' });
  });

  it('lets the task write and search memory records, but not send events', () => {
    const template = synth('prod');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:BatchCreateMemoryRecords',
              'bedrock-agentcore:RetrieveMemoryRecords',
            ],
          }),
        ]),
      }),
    });
    expect(JSON.stringify(template.toJSON())).not.toContain('bedrock-agentcore:CreateEvent');
  });
});
