import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvConfig } from './config.js';
import {
  DEV_BASIC_AUTH_PASSWORD,
  DEV_BASIC_AUTH_USER,
  HOSTED_ZONE_ID,
  ROOT_DOMAIN,
  WAF_ARN_PARAMETER,
} from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WebStackProps extends cdk.StackProps {
  envConfig: EnvConfig;
  httpApi: apigwv2.HttpApi;
}

/**
 * Private S3 bucket + CloudFront (OAC) for the static React app, WAF at the
 * CloudFront layer covering both static and /api/* traffic, and the Route53
 * alias record(s) for this stage's domain name(s).
 */
export class WebStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly siteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const hostedZone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ROOT_DOMAIN,
    });

    const isProd = props.envConfig.envName === 'prod';

    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `btfp-${props.envConfig.envName}-site`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    const allDomainNames = [props.envConfig.domainName, ...props.envConfig.aliasDomainNames];

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.envConfig.domainName,
      subjectAlternativeNames: props.envConfig.aliasDomainNames,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Kept to two rule groups (~$6-8/mo) to stay within budget; see docs/infra.md.
    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: 'AWS-CommonRuleSet',
        priority: isProd ? 0 : 1,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `btfp-${props.envConfig.envName}-common`,
          sampledRequestsEnabled: true,
        },
      },
      {
        name: 'RateLimit',
        priority: isProd ? 1 : 2,
        action: { block: {} },
        statement: {
          rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `btfp-${props.envConfig.envName}-ratelimit`,
          sampledRequestsEnabled: true,
        },
      },
    ];

    // Dev isn't meant to be public or bot-crawlable: block everything at the
    // edge unless it carries the right HTTP Basic Auth header. Runs before
    // the other rules (priority 0) so unauthenticated traffic never reaches
    // origin at all — belt-and-suspenders with the robots.txt/X-Robots-Tag
    // handling below, which only helps for well-behaved crawlers.
    if (!isProd) {
      const basicAuthValue = `Basic ${Buffer.from(`${DEV_BASIC_AUTH_USER}:${DEV_BASIC_AUTH_PASSWORD}`).toString('base64')}`;
      rules.push({
        name: 'RequireBasicAuth',
        priority: 0,
        action: {
          block: {
            customResponse: {
              responseCode: 401,
              responseHeaders: [{ name: 'WWW-Authenticate', value: 'Basic realm="dev"' }],
            },
          },
        },
        statement: {
          notStatement: {
            statement: {
              byteMatchStatement: {
                searchString: basicAuthValue,
                fieldToMatch: { singleHeader: { Name: 'authorization' } },
                textTransformations: [{ priority: 0, type: 'NONE' }],
                positionalConstraint: 'EXACTLY',
              },
            },
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `btfp-${props.envConfig.envName}-basicauth`,
          sampledRequestsEnabled: true,
        },
      });
    }

    // Prod attaches the shared ACL owned by the dotio repo (DotioWaf: one ACL for every
    // bubbletech site, with a Host-scoped rate limit for this one). Dev keeps its own
    // ACL because of the Basic Auth rule above, which must not touch prod traffic.
    let webAclId: string;
    if (isProd) {
      webAclId = ssm.StringParameter.valueForStringParameter(this, WAF_ARN_PARAMETER);
    } else {
      const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `btfp-${props.envConfig.envName}-waf`,
          sampledRequestsEnabled: true,
        },
        rules,
      });
      webAclId = webAcl.attrArn;
    }

    // Extra layer for any crawler that (a) somehow has valid dev credentials
    // and (b) actually respects these signals: tell it not to index anyway.
    const noIndexPolicy = isProd
      ? undefined
      : new cloudfront.ResponseHeadersPolicy(this, 'NoIndexPolicy', {
          customHeadersBehavior: {
            customHeaders: [{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }],
          },
        });

    // HttpApi.apiEndpoint is "https://{id}.execute-api.{region}.amazonaws.com"; CloudFront needs just the host.
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', props.httpApi.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const apiBehavior: cloudfront.AddBehaviorOptions = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    // The origin request policy above strips the viewer's Host header before
    // forwarding to API Gateway (required so it doesn't fight API Gateway's
    // own execute-api hostname). The sitemap needs the real public domain to
    // build absolute URLs, so this edge function re-adds it as a header.
    const forwardHostFunction = new cloudfront.Function(this, 'ForwardHostFunction', {
      code: cloudfront.FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          request.headers['x-forwarded-host'] = { value: request.headers.host.value };
          return request;
        }
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // SPA client-side routes (e.g. /things/:id/:slug) have no matching S3
    // object by default. Rewriting the request URI here — before it ever
    // reaches S3 — means S3 always returns a real 200 for those paths, so no
    // error-response rewriting is needed at all. That matters because
    // CloudFront's distribution-level errorResponses can't be scoped to one
    // behavior: an earlier version of this stack used errorResponses for the
    // SPA fallback, and it silently rewrote genuine 404s from the /api/*
    // behavior (a real NotFoundException from the BFF) into 200 + index.html
    // too. Scoping the fix to a viewer-request function on just the default
    // (S3) behavior avoids that entirely.
    //
    // Prod appends /index.html to the *current* path rather than always
    // rewriting to a single generic /index.html — apps/web/scripts/
    // prerender.mjs (see docs/seo.md) saves real per-route rendered HTML at
    // exactly these paths (e.g. things/<id>/<slug>/index.html) as part of
    // the prod build, so crawlers get real content instead of the empty
    // shell. Dev is never prerendered (it's not meant to be crawled/indexed
    // at all — see docs/infra.md) and so keeps the old always-serve-the-
    // generic-shell behavior; using the per-path version there would 403
    // every route except "/" since no prerendered files exist for dev.
    const spaFallbackFunction = new cloudfront.Function(this, 'SpaFallbackFunction', {
      code: cloudfront.FunctionCode.fromInline(
        isProd
          ? `
        function handler(event) {
          var request = event.request;
          var uri = request.uri;
          if (uri.endsWith('/')) {
            request.uri = uri + 'index.html';
            return request;
          }
          var lastSegment = uri.split('/').pop();
          if (lastSegment.indexOf('.') === -1) {
            request.uri = uri + '/index.html';
          }
          return request;
        }
      `
          : `
        function handler(event) {
          var request = event.request;
          var uri = request.uri;
          var lastSegment = uri.split('/').pop();
          if (lastSegment.indexOf('.') === -1) {
            request.uri = '/index.html';
          }
          return request;
        }
      `,
      ),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: noIndexPolicy,
        functionAssociations: [
          { function: spaFallbackFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/api/*': { origin: apiOrigin, ...apiBehavior, responseHeadersPolicy: noIndexPolicy },
        // Both dynamic (content differs per stage, robots.txt via env var;
        // sitemap enumerates live thing data) rather than static files, so
        // they can't be served from S3 like the rest of the site.
        '/sitemap.xml': {
          origin: apiOrigin,
          ...apiBehavior,
          responseHeadersPolicy: noIndexPolicy,
          functionAssociations: [
            {
              function: forwardHostFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        '/robots.txt': { origin: apiOrigin, ...apiBehavior, responseHeadersPolicy: noIndexPolicy },
      },
      domainNames: allDomainNames,
      certificate,
      webAclId,
      defaultRootObject: 'index.html',
    });

    for (const domainName of allDomainNames) {
      new route53.ARecord(this, `AliasRecord-${domainName}`, {
        zone: hostedZone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      });
    }

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../../apps/web/dist'))],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: this.siteBucket.bucketName });
  }
}
