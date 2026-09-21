export const ROOT_DOMAIN = 'badthingsforpets.com';

// Everything lives in us-east-1: required for CloudFront's ACM cert and its
// CLOUDFRONT-scope WAF WebACL, and simplest for a single-region MVP.
export const AWS_REGION = 'us-east-1';
export const AWS_ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;

// Set after `cdk deploy BtfpDns` once, from its HostedZoneId output.
export const HOSTED_ZONE_ID = process.env.BTFP_HOSTED_ZONE_ID ?? 'REPLACE_AFTER_DNS_STACK_DEPLOY';

// WAF-level Basic Auth for the dev stage only — dev isn't meant to be public
// or bot-crawlable. Set both at deploy time; never commit real values.
export const DEV_BASIC_AUTH_USER = process.env.BTFP_DEV_BASIC_AUTH_USER ?? 'dev';
export const DEV_BASIC_AUTH_PASSWORD =
  process.env.BTFP_DEV_BASIC_AUTH_PASSWORD ?? 'REPLACE_BEFORE_DEPLOYING_DEV';

// Shared by dev + prod; the EmailStack SES identity is for the whole domain.
export const SES_FROM_ADDRESS = process.env.BTFP_SES_FROM_ADDRESS ?? `noreply@${ROOT_DOMAIN}`;

// Catch-all inbound mail (any address @ROOT_DOMAIN) forwards here — see
// EmailStack. Not a secret, just an address, so a real default is fine
// (same reasoning as SES_FROM_ADDRESS above).
export const FORWARD_TO_ADDRESS = process.env.BTFP_FORWARD_TO_ADDRESS ?? 'john.josef@gmail.com';

// Session JWT signing secret. Deliberately separate per environment — never
// commit real values. Was previously missing entirely, silently falling
// back to a hardcoded (and public, since this repo is public) default.
export const DEV_JWT_SECRET = process.env.BTFP_DEV_JWT_SECRET ?? 'REPLACE_BEFORE_DEPLOYING_DEV';
export const PROD_JWT_SECRET = process.env.BTFP_PROD_JWT_SECRET ?? 'REPLACE_BEFORE_DEPLOYING_PROD';

// Claude Haiku 4.5 needs the inference profile, not the bare model id — see docs/infra.md.
export const BEDROCK_INFERENCE_PROFILE_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// The scraper judges hazard claims from web snippets, so it uses a stronger model than the
// BFF's classification calls.
export const SCRAPER_BEDROCK_INFERENCE_PROFILE_ID = 'us.anthropic.claude-sonnet-4-6';

// Optional: Brave Search API, used as an evidence signal for
// professional-verification's org-legitimacy check (see
// docs/verification-flow.md). Shared by dev + prod, same key. Left empty
// rather than a placeholder — SearchHistoryService degrades gracefully
// (returns null) when unset, same as everything else in that pipeline.
// (Was Google Custom Search JSON API — Google closed that API to new
// customers, so it's been retired in favor of Brave.)
export const BRAVE_SEARCH_API_KEY = process.env.BTFP_BRAVE_SEARCH_API_KEY ?? '';

// GitHub OAuth app — only registered for prod so far (GitHub allows one
// callback URL per app, and dev is Basic-Auth-walled and not meant for
// public OAuth testing anyway — see docs/verification-flow.md). Client ID
// isn't sensitive (every OAuth redirect URL exposes it), so a real default
// is fine here same as the other non-secret values above. The client
// *secret* is deliberately NOT here — it lives in SSM Parameter Store
// (SecureString, see docs/verification-flow.md) and the Lambda fetches it
// at cold start (apps/bff/src/lambda.ts), rather than sitting in this repo
// or as a plaintext CloudFormation/Lambda-console-visible env var.
export const GITHUB_CLIENT_ID = process.env.BTFP_GITHUB_CLIENT_ID ?? 'Ov23lidrry3aBdRe4yUg';
export const GITHUB_CLIENT_SECRET_PARAM_NAME = '/btfp/github-client-secret';

// CiStack's GitHub Actions OIDC role trust policy is scoped to this repo —
// see docs/ci-cd.md. GitHub's OIDC `sub` claim includes immutable numeric
// IDs alongside the org/repo names (`owner@ownerId/repo@repoId`, not plain
// `owner/repo` — confirmed empirically via a debug step that printed the
// actual token, not assumed from docs). Using the ID-suffixed form means the
// repo's own id survives a rename/transfer — confirmed when this repo moved
// GenomeInc -> bubltec, repo id 1301972078 stayed the same — but the owner
// id is tied to the org itself, so a genuine move to a *different* org still
// needs this constant (and a CiStack redeploy) updated, same as here.
export const GITHUB_REPO = 'bubltec@310348769/btfp@1301972078';

export interface EnvConfig {
  envName: 'dev' | 'prod';
  domainName: string;
  aliasDomainNames: string[];
}

export const environments: Record<'dev' | 'prod', EnvConfig> = {
  dev: {
    envName: 'dev',
    domainName: `dev.${ROOT_DOMAIN}`,
    aliasDomainNames: [],
  },
  prod: {
    envName: 'prod',
    domainName: ROOT_DOMAIN,
    aliasDomainNames: [`www.${ROOT_DOMAIN}`],
  },
};
