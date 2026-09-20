# Infra

AWS CDK (TypeScript), everything in `us-east-1` (required for CloudFront's ACM cert and its
CLOUDFRONT-scope WAF WebACL; also simplest for a single-region MVP). No NAT gateway anywhere
in this repo — the BFF Lambda talks to DynamoDB directly with no VPC at all, and the one VPC
that does exist (`Scraper`, for the scheduled Fargate task below) is public-subnets-only, so
it costs nothing extra either.

## Automated deploys

Pushes to `main` normally deploy themselves — see [docs/ci-cd.md](./ci-cd.md) for the full
GitHub Actions pipeline (build once → dev → e2e → human-approved promotion to prod, including
how GitHub Actions authenticates to AWS via OIDC). Everything below in this file is the manual
`cdk deploy` path: still accurate, still how `BtfpCi` itself and any one-off/hotfix/debugging
deploy gets done, just no longer the routine way changes ship.

## Stacks

- **`BtfpDns`** — one Route53 public hosted zone for `badthingsforpets.com`. Deployed once,
  standalone, before anything else.
- **`BtfpEmail`** — one SES domain identity for `badthingsforpets.com`, shared by dev and
  prod. Deployed once, standalone, alongside `BtfpDns` — auto-creates its DKIM DNS records
  against the same hosted zone. Used for the professional-verification code emails (see
  `docs/verification-flow.md`).
- **`BtfpCi`** — one IAM role GitHub Actions assumes via OIDC to deploy. Deployed once,
  standalone. See [docs/ci-cd.md](./ci-cd.md).
- **`BtfpDev`** / **`BtfpProd`** — CDK Stages, each composing:
  - **Data** — DynamoDB `Content` + `Users` tables, on-demand billing.
  - **Scraper** — a VPC (public subnets only, no NAT gateway), an ECS cluster, one
    Fargate task definition on an EventBridge schedule (every 6h), plus an AgentCore
    Gateway (Web Search) and AgentCore Memory. The task reads Google Trends via
    AgentCore Browser and writes unverified `Contribution`s — see
    [docs/scraper.md](./scraper.md).
  - **Api** — one Lambda (container image — see [docs/ci-cd.md](./ci-cd.md)) running the
    NestJS BFF, behind an API Gateway HTTP API. Traffic hits a `live` alias
    (`AutoPublishAlias`). Prod canaries 10% / 5 minutes; dev is `AllAtOnce`.
  - **Web** — S3 (private, OAC) + CloudFront + WAFv2 + ACM cert + Route53 alias record(s).

`BtfpDev` serves `dev.badthingsforpets.com`; `BtfpProd` serves `badthingsforpets.com` and
`www.badthingsforpets.com`.

### One-time: migrating a function onto SAM's `AutoPublishAlias`

If a Lambda function previously got its `live` alias from a CDK-managed `fn.addAlias('live')`
(pre-SAM canary setup), SAM's `AutoPublishAlias` cannot create its own `live` alias while
that one still exists — CloudFormation has no built-in way to order "delete the old alias"
before "create the new one" without an ordering dependency that cycles back on itself (the
migration needs the function's name via `Ref`, so it always depends on the function; adding
the reverse dependency propagates through SAM to the function's generated `Version` and
`Alias` too, forming a direct cycle). Delete the stale alias by hand, once, before deploying:

```bash
aws lambda delete-alias --function-name <physical-function-name> --name live
```

Safe to run even if the alias doesn't exist (returns `ResourceNotFoundException`). Do this
right before the deploy that introduces `publishLiveAlias` for that function — the alias is
briefly gone until SAM recreates it during that same deploy. Fine for dev (Basic-Auth-walled);
for prod, do it immediately before approving `deploy-prod` to minimize the gap.

## Budget (rough, at low/unknown traffic)

| Item | Cost |
|---|---|
| Route53 hosted zone | ~$0.50/mo |
| ACM certificate | free |
| Lambda + API Gateway | ~free under ~1M requests/mo |
| DynamoDB (on-demand) | pennies at this scale |
| CloudFront | pennies at this scale |
| WAF (2 rule groups) | ~$6-8/mo |
| SES | ~free — $0.10/1,000 emails, and this only sends verification codes |
| Bedrock (Claude Haiku, domain classification + scraper extraction) | ~free — a few cents per 1,000 calls |
| AgentCore Web Search (scraper, ≤8 topics/run × 4 runs/day) | ~$1-2/mo per env at $7/1,000 queries |
| AgentCore Browser + Memory (scraper) | pennies at this cadence |
| Brave Search (optional, org-legitimacy signal) | free tier covers this app's volume |
| ECS Fargate (scraper, ~5min/run, every 6h) | ~$1-2/mo per env |
| VPC (scraper, public-only, no NAT) | free |

Dev + prod together should land well under $50/mo unless traffic spikes hard. The two
biggest levers if it doesn't: drop WAF's rate-limit rule, or merge dev+prod's WAF into a
single shared WebACL.

## SES sandbox

New SES accounts start in sandbox mode: can only send to individually-verified recipient
addresses, and at a low rate. Moving to production access is an AWS Support request
submitted via the SES console (Account dashboard → Request production access) — not
something CDK or the API can do; AWS reviews it, typically same-day. Until that's done,
`/verification/professional/request` and `/auth/email/request` will fail to deliver to
any address you haven't manually verified with
`aws sesv2 create-email-identity --email-identity <address>` (AWS emails a confirmation
link to that address).

## Bedrock: Anthropic use case details form

Separately from IAM permissions, AWS/Anthropic require submitting a one-time "use case
details" form for the account before Anthropic models on Bedrock will actually respond —
`bedrock:InvokeModel` fails with "Model use case details have not been submitted for this
account" until it's done. Not automatable; submit it from the Bedrock console (Model
access page). `BedrockClassifierService` degrades gracefully without it — the domain
classification is just skipped, org-email verification still works.

## Secrets

Real secret values live in AWS SSM Parameter Store (SecureString), under
`/btfp/dev/*`, `/btfp/prod/*`, and `/btfp/shared/*` (plus the standalone
`/btfp/github-client-secret`, prod-only, referenced but not managed by CDK
— see `GITHUB_CLIENT_SECRET_PARAM_NAME` in `infra/cdk/lib/config.ts`).
That's the source of truth, not any local file.

- `pnpm secrets:sync dev` / `pnpm secrets:sync prod` — pulls current values
  down into `infra/cdk/.env.deploy.local` (and, for `dev`, also updates
  `JWT_SECRET`/`GITHUB_CLIENT_SECRET` in `apps/bff/.env` if that file
  exists). Run this on a new machine instead of hand-typing values from
  memory.
- `pnpm secrets:push dev` / `pnpm secrets:push prod` — the reverse: reads
  `infra/cdk/.env.deploy.local` and writes any real (non-placeholder) values
  up to SSM. Use this after rotating a secret locally.

Both need AWS credentials (`aws sso login --profile <your-profile>` first —
same as [Deploy order](#deploy-order) below). See
`infra/cdk/scripts/secrets.ts` for the exact key mapping.

## Dev is not public

Dev isn't meant to be indexed, crawled, or generally reachable — it's a working environment,
not the product. `WebStack` adds a dev-only WAF rule requiring HTTP Basic Auth on every
request (site and API alike), returns `Disallow: /` from `robots.txt`, and sends
`X-Robots-Tag: noindex, nofollow` on every response. Prod has none of this — see
[LLM ingestibility](#llm-ingestibility) below for why prod deliberately goes the other way.

Real credentials live in `infra/cdk/.env.deploy.local` (gitignored — never commit real
values; see [Secrets](#secrets) above for how they get there). Load them before running any
`cdk` command against dev — with [direnv](https://direnv.net) set up (`infra/cdk/.envrc` is
already in the repo, just `direnv allow` once), `cd infra/cdk` loads them automatically.
Without direnv, load them by hand instead:

```bash
cd infra/cdk
set -a && source .env.deploy.local && set +a
npx cdk deploy BtfpDev/Web
```

`config.ts` falls back to an obviously-fake placeholder password if the env var isn't set,
so `cdk synth` still works credential-free — but don't deploy dev with the placeholder in
place, it's not a real barrier.

## LLM ingestibility

Prod deliberately does the opposite of dev: `robots.txt` allows known AI crawlers by name
(GPTBot, ClaudeBot, PerplexityBot, etc.), `/sitemap.xml` lists every thing page, `/llms.txt`
summarizes the site and API for agentic consumption, and `/api/openapi.json` exposes the
full API contract. The frontend is a client-side-only SPA, so a crawler that doesn't execute
JavaScript would otherwise see an empty shell for `/` and `/things/:id` — fixed for prod via
build-time prerendering, see [docs/seo.md](./seo.md).

## Deploy order

This is the manual path — normally `main` deploys itself, see
[docs/ci-cd.md](./ci-cd.md). Steps 7–11 below are exactly what `deploy.yml`'s jobs run, just by
hand.

1. `aws sso login --profile <your-profile>`
2. `pnpm --filter @btfp/infra cdk bootstrap` (once per account/region)
3. `pnpm --filter @btfp/infra cdk deploy BtfpDns` — copy the `HostedZoneId` output
4. Set `BTFP_HOSTED_ZONE_ID` (env var, see `infra/cdk/lib/config.ts`) to that value
5. Set the NS records from `BtfpDns`'s `NameServers` output at your domain registrar
6. `pnpm --filter @btfp/infra cdk deploy BtfpEmail` — SES domain identity, needs
   `BTFP_HOSTED_ZONE_ID` set same as above. DKIM verification takes a few minutes to
   propagate; check with `aws sesv2 get-email-identity --email-identity badthingsforpets.com`.
7. `pnpm --filter @btfp/bff build` — the Api stack deploys the Lambda from
   `apps/bff/dist`, so it must exist first
8. `pnpm --filter @btfp/web build` — the Web stack's `BucketDeployment` uploads
   `apps/web/dist` to S3 and invalidates CloudFront as part of `cdk deploy`, so this must
   exist first too
9. For a prod deploy only: `PRERENDER_API_ORIGIN=https://badthingsforpets.com pnpm
   --filter @btfp/web run prerender` — crawls the just-built `dist/` and saves real
   per-route rendered HTML for crawlers. See [docs/seo.md](./seo.md). Skip for dev — it's
   not meant to be crawled/indexed at all.
10. For dev: load `infra/cdk/.env.deploy.local` (see [Secrets](#secrets) above) before
    deploying — the Basic Auth password comes from there. For prod, no extra env vars needed.
11. `pnpm --filter @btfp/infra cdk deploy BtfpDev/* BtfpProd/*` — this also deploys the
    `Scraper` stack (Fargate task + AgentCore Gateway/Memory). No extra secrets to
    push; the task role is enough. If the Gateway URL env var is missing the task
    logs a skip line and no-ops.

The Bedrock inference profile id (`BEDROCK_INFERENCE_PROFILE_ID` in `config.ts`) is
hardcoded to Claude Haiku 4.5's current profile — Anthropic model ids on Bedrock are
versioned and do change over time; if `bedrock:InvokeModel` starts failing with a
model-not-found error, check `aws bedrock list-inference-profiles` for the current id.
