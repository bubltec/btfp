import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTED_ZONE_ID, ROOT_DOMAIN, FORWARD_TO_ADDRESS } from './config.js';
import { publishLiveAlias } from './lambda-canary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SES domain identity, deployed once (like BtfpDns) rather than per-stage —
 * dev and prod share the same sending domain. Auto-creates DKIM + MAIL FROM
 * DNS records against the existing hosted zone.
 *
 * New SES accounts start in sandbox mode (can only send to
 * individually-verified recipients) until production access is requested
 * via the SES console — an AWS Support review, not automatable here. (A
 * first request was denied — see docs/infra.md — most likely because the
 * account had nothing public to point at yet.)
 *
 * Also sets up receiving for two specific addresses — john@ and info@ —
 * which forward to FORWARD_TO_ADDRESS. Standard SES receive pattern: MX
 * record -> receipt rule saves the raw message to S3 and invokes a small
 * Lambda that rewrites headers and re-sends it via SendRawEmail.
 * FORWARD_TO_ADDRESS itself has to be individually verified in SES too, same
 * sandbox-mode restriction as everything else sent from this account until
 * production access is granted. Other addresses at the domain still accept
 * mail during the SMTP conversation (see the comment on the receipt rule
 * below) but nothing forwards for them.
 */
export class EmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const hostedZone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ROOT_DOMAIN,
    });

    new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.publicHostedZone(hostedZone),
      // mail.<domain> — own bounce/MAIL FROM domain instead of the shared
      // amazonses.com default, for deliverability. DNS (MX + SPF) for this
      // subdomain was set up manually in the SES console; this is what
      // actually tells SES to use it.
      mailFromDomain: `mail.${ROOT_DOMAIN}`,
    });

    new route53.MxRecord(this, 'InboundMx', {
      zone: hostedZone,
      values: [{ priority: 10, hostName: `inbound-smtp.${this.region}.amazonaws.com` }],
    });

    const mailBucket = new s3.Bucket(this, 'InboundMailBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    mailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: [mailBucket.arnForObjects('*')],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    );

    const forwarderFn = new lambda.DockerImageFunction(this, 'ForwarderFunction', {
      // No pinned functionName — zip→image is a CloudFormation replacement,
      // and a fixed name blocks create-before-delete (same lesson as
      // BffFunction in api-stack.ts).
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../lambda/email-forwarder'),
        {
          platform: Platform.LINUX_AMD64,
        },
      ),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MAIL_BUCKET_NAME: mailBucket.bucketName,
        FORWARD_FROM_ADDRESS: `forwarder@${ROOT_DOMAIN}`,
        FORWARD_TO_ADDRESS,
      },
    });

    const live = publishLiveAlias(forwarderFn, 'AllAtOnce');

    mailBucket.grantRead(forwarderFn);
    forwarderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendRawEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
      }),
    );
    // sesActions.Lambda's bind() below auto-grants SES invoke permission on
    // the live alias, so no explicit addPermission call needed here.

    const ruleSet = new ses.ReceiptRuleSet(this, 'ReceiptRuleSet', {
      receiptRuleSetName: 'btfp-inbound',
      dropSpam: true,
    });

    // Not catch-all — only these two addresses forward to a real inbox.
    // Anything else at the domain still accepts mail during the SMTP
    // conversation (verified-domain sending is authorized independent of
    // receipt rules, which is what lets E2E test addresses like
    // e2e-<timestamp>@badthingsforpets.com send successfully — see
    // apps/e2e/scripts/app-context.ts) but has no matching rule, so nothing
    // gets stored or forwarded for it.
    const forwardRule = ruleSet.addRule('ForwardRule', {
      recipients: [`john@${ROOT_DOMAIN}`, `info@${ROOT_DOMAIN}`],
      scanEnabled: true,
      actions: [
        new sesActions.S3({ bucket: mailBucket }),
        new sesActions.Lambda({ function: live }),
      ],
    });

    // SES has exactly one "active" receipt rule set per account/region, and
    // activating one isn't a CloudFormation resource property — it's a
    // separate, mutable API call. AwsCustomResource shells out to the SDK
    // directly on create/update; explicit dependencies since referencing a
    // hardcoded receiptRuleSetName string (rather than a generated one)
    // gives CDK nothing to infer an ordering from on its own.
    const activateRuleSet = new AwsCustomResource(this, 'ActivateReceiptRuleSet', {
      onCreate: {
        service: '@aws-sdk/client-ses',
        action: 'SetActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: PhysicalResourceId.of(`activate-${ruleSet.receiptRuleSetName}`),
      },
      onUpdate: {
        service: '@aws-sdk/client-ses',
        action: 'SetActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: PhysicalResourceId.of(`activate-${ruleSet.receiptRuleSetName}`),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    activateRuleSet.node.addDependency(ruleSet);
    activateRuleSet.node.addDependency(forwardRule);
  }
}
