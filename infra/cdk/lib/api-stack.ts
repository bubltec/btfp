import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvConfig } from './config.js';
import {
  BEDROCK_INFERENCE_PROFILE_ID,
  BRAVE_SEARCH_API_KEY,
  DEV_JWT_SECRET,
  FORWARD_TO_ADDRESS,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET_PARAM_NAME,
  PROD_JWT_SECRET,
  ROOT_DOMAIN,
  SES_FROM_ADDRESS,
} from './config.js';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { publishCurrentAlias } from './lambda-canary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ApiStackProps extends cdk.StackProps {
  envConfig: EnvConfig;
  contentTable: dynamodb.Table;
  usersTable: dynamodb.Table;
}

/**
 * One Lambda running the whole NestJS BFF behind an HTTP API (cheaper than
 * REST API). CloudFront (in WebStack) fronts this at /api/*, so there's no
 * custom domain or ACM cert on the API Gateway itself.
 */
export class ApiStack extends cdk.Stack {
  readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const isProd = props.envConfig.envName === 'prod';

    // GitHub OAuth app is only registered for prod right now (see
    // config.ts) — dev gets none of these env vars and GithubStrategy just
    // falls back to its "not-configured" placeholder, same as before.
    const githubEnv: Record<string, string> = isProd
      ? {
          GITHUB_CLIENT_ID,
          GITHUB_CLIENT_SECRET_PARAM: GITHUB_CLIENT_SECRET_PARAM_NAME,
          GITHUB_CALLBACK_URL: `https://${ROOT_DOMAIN}/api/auth/github/callback`,
        }
      : {};

    const handler = new lambda.DockerImageFunction(this, 'BffFunction', {
      // No explicit functionName: a pinned name means CloudFormation can't
      // create-before-delete on any future required-replacement (it did
      // hit exactly this migrating off the old zip-based Function, which
      // rolled back cleanly) — letting CDK auto-generate one keeps that
      // path clean going forward. Nothing else in the repo references the
      // function name as a literal string (checked before removing it).
      //
      // Content-hash-addressed: dev and prod both build from the same
      // {account, region} bootstrap container-assets ECR repo, so if CI
      // publishes the exact same apps/bff/dist build to both, the prod
      // deploy's image push is a genuine no-op (already exists) rather than
      // a rebuild — see docs/ci-cd.md. Pinning the platform explicitly
      // matters: without it, a local build on Apple Silicon hashes
      // differently than GHA's x86 runners and silently produces a second,
      // undeduplicated image.
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../../apps/bff'), {
        platform: Platform.LINUX_AMD64,
      }),
      memorySize: 512,
      // Email sign-in does DNS + homepage fetch + Bedrock + SES in one request;
      // on a cold container (right after deploy) that can exceed 15s.
      timeout: cdk.Duration.seconds(30),
      // Explicit group so logs expire. Lambda's auto-created group never does.
      logGroup: new logs.LogGroup(this, 'BffLogGroup', {
        retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        NODE_ENV: 'production',
        // Maps minified stack frames back to src/*.ts using the bundled .map
        // (see apps/bff/Dockerfile).
        NODE_OPTIONS: '--enable-source-maps',
        STAGE: props.envConfig.envName,
        CONTENT_TABLE_NAME: props.contentTable.tableName,
        USERS_TABLE_NAME: props.usersTable.tableName,
        SES_FROM_ADDRESS,
        BEDROCK_INFERENCE_PROFILE_ID,
        JWT_SECRET: isProd ? PROD_JWT_SECRET : DEV_JWT_SECRET,
        BRAVE_SEARCH_API_KEY,
        // Was missing entirely — fell back to its localhost default in every
        // deployed environment, so the OAuth callback and /auth/logout
        // redirected real visitors' browsers to http://localhost:5173.
        WEB_ORIGIN: `https://${props.envConfig.domainName}`,
        ...githubEnv,
      },
    });

    const current = publishCurrentAlias(handler, {
      canary: isProd ? codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES : undefined,
    });

    props.contentTable.grantReadWriteData(handler);
    props.usersTable.grantReadWriteData(handler);

    if (isProd) {
      ssm.StringParameter.fromSecureStringParameterAttributes(this, 'GithubClientSecretParam', {
        parameterName: GITHUB_CLIENT_SECRET_PARAM_NAME,
      }).grantRead(handler);
    }

    // In SES sandbox mode, SendEmail is authorized against BOTH the sending
    // identity (our domain) and the recipient's identity ARN when that
    // recipient is itself a verified identity — which every sandbox test
    // recipient necessarily is. Scoping this to just the domain identity
    // works in production SES but 403s in sandbox, so wildcard the resource
    // instead of trying to enumerate recipients.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
      }),
    );

    // Cross-region inference profiles need permission on both the profile
    // itself and the underlying foundation models it can route requests to.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_INFERENCE_PROFILE_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        ],
      }),
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `btfp-${props.envConfig.envName}-api`,
      // Alias, not `$LATEST` — otherwise a prod canary never sees user traffic.
      defaultIntegration: new HttpLambdaIntegration('BffIntegration', current),
    });

    if (isProd) {
      // The canary alarms only guard a deploy. This one notifies on 5xx in
      // steady state. The email subscription must be confirmed once by the
      // recipient (SNS sends a confirmation link) before alerts are delivered.
      const alerts = new sns.Topic(this, 'AlertsTopic');
      alerts.addSubscription(new subscriptions.EmailSubscription(FORWARD_TO_ADDRESS));
      new cloudwatch.Alarm(this, 'ApiServerErrors', {
        alarmDescription: 'BFF API returned 3+ 5xx responses in 5 minutes',
        metric: this.httpApi.metricServerError({
          period: cdk.Duration.minutes(5),
          statistic: 'sum',
        }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(alerts));
    }

    // HttpLambdaIntegration.grantInvoke is a no-op when the target is an
    // imported/SAM alias (fn.functionArn is a token, so CDK skips
    // addPermission). Prod is 500 on every /api/* because :live has no
    // resource policy. This CfnPermission is a real stack resource on the
    // alias the HTTP API invokes.
    new lambda.CfnPermission(this, 'HttpApiInvokeAlias', {
      action: 'lambda:InvokeFunction',
      functionName: current.functionArn,
      principal: 'apigateway.amazonaws.com',
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.httpApi.apiId}/*/*`,
    });

    new cdk.CfnOutput(this, 'HttpApiUrl', { value: this.httpApi.apiEndpoint });
  }
}
