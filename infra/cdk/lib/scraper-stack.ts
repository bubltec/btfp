import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvConfig } from './config.js';
import { BEDROCK_INFERENCE_PROFILE_ID } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ScraperStackProps extends cdk.StackProps {
  envConfig: EnvConfig;
  contentTable: dynamodb.Table;
}

/**
 * Scheduled ECS Fargate task, not a long-running service — every 6h it
 * opens Google Trends (Pets and Animals) via AgentCore Browser, searches
 * new topics through AgentCore Gateway's Web Search tool, classifies hits
 * with Bedrock, and writes unverified Contribution items into the existing
 * moderation queue (never a verified Thing directly — see docs/scraper.md).
 * No inbound traffic, so the VPC has only public subnets and no NAT
 * gateway — near-zero extra cost. assignPublicIp is required on the task
 * below as the direct consequence of that: with no NAT gateway, a task
 * without a public IP has no route out at all.
 */
export class ScraperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ScraperStackProps) {
    super(scope, id, props);

    const envName = props.envConfig.envName;

    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `AgentCore Gateway execution role for the ${envName} scraper web-search connector`,
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeWebSearch'],
        resources: [`arn:aws:bedrock-agentcore:${this.region}:aws:tool/web-search.v1`],
      }),
    );

    const memoryRole = new iam.Role(this, 'MemoryRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `AgentCore Memory extraction role for the ${envName} scraper`,
    });
    memoryRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_INFERENCE_PROFILE_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        ],
      }),
    );

    // aws-cdk-lib 2.261 does not yet ship L1/L2 constructs for these; raw
    // CloudFormation types are current and what the AgentCore docs use.
    const gateway = new cdk.CfnResource(this, 'WebSearchGateway', {
      type: 'AWS::BedrockAgentCore::Gateway',
      properties: {
        Name: `btfp-${envName}-scraper-search`,
        Description: 'Managed web search for the pet-hazard scraper',
        RoleArn: gatewayRole.roleArn,
        ProtocolType: 'MCP',
        AuthorizerType: 'AWS_IAM',
      },
    });

    new cdk.CfnResource(this, 'WebSearchTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gateway.getAtt('GatewayIdentifier'),
        Name: 'web-search',
        Description: 'AgentCore Web Search connector',
        TargetConfiguration: {
          Mcp: {
            Connector: {
              Source: { ConnectorId: 'web-search' },
              Configurations: [{ Name: 'WebSearch', ParameterValues: {} }],
            },
          },
        },
        CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
      },
    });

    const memory = new cdk.CfnResource(this, 'ScraperMemory', {
      type: 'AWS::BedrockAgentCore::Memory',
      properties: {
        Name: `btfp_${envName}_scraper`,
        Description: 'Remembers trending topics the scraper has already researched',
        EventExpiryDuration: 365,
        MemoryExecutionRoleArn: memoryRole.roleArn,
        MemoryStrategies: [
          {
            SemanticMemoryStrategy: {
              Name: 'scraperFacts',
              Namespaces: ['/scraper/{actorId}'],
            },
          },
        ],
      },
    });

    const vpc = new ec2.Vpc(this, 'ScraperVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: false });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    props.contentTable.grantReadWriteData(taskDef.taskRole);

    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_INFERENCE_PROFILE_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        ],
      }),
    );

    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:StartBrowserSession',
          'bedrock-agentcore:StopBrowserSession',
          'bedrock-agentcore:GetBrowserSession',
          'bedrock-agentcore:ListBrowserSessions',
          'bedrock-agentcore:UpdateBrowserStream',
          // Required for Playwright's CDP WebSocket. StartBrowserSession
          // succeeds without it; connectOverCDP then 403s.
          'bedrock-agentcore:ConnectBrowserAutomationStream',
        ],
        resources: ['*'],
      }),
    );

    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [gateway.getAtt('GatewayArn').toString()],
      }),
    );

    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:ListMemoryRecords',
          'bedrock-agentcore:GetMemoryRecord',
        ],
        resources: [memory.getAtt('MemoryArn').toString()],
      }),
    );

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDef.addContainer('scraper', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../../apps/scraper'), {
        platform: Platform.LINUX_AMD64,
      }),
      environment: {
        STAGE: envName,
        AWS_REGION: this.region,
        CONTENT_TABLE_NAME: props.contentTable.tableName,
        BEDROCK_INFERENCE_PROFILE_ID,
        AGENTCORE_GATEWAY_URL: gateway.getAtt('GatewayUrl').toString(),
        AGENTCORE_MEMORY_ID: memory.getAtt('MemoryId').toString(),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'scraper', logGroup }),
    });

    const rule = new events.Rule(this, 'ScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
    });

    rule.addTarget(
      new targets.EcsTask({
        cluster,
        taskDefinition: taskDef,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        taskCount: 1,
      }),
    );

    new cdk.CfnOutput(this, 'ClusterArn', { value: cluster.clusterArn });
    new cdk.CfnOutput(this, 'TaskDefinitionArn', { value: taskDef.taskDefinitionArn });
    new cdk.CfnOutput(this, 'GatewayUrl', { value: gateway.getAtt('GatewayUrl').toString() });
    new cdk.CfnOutput(this, 'MemoryId', { value: memory.getAtt('MemoryId').toString() });
  }
}
