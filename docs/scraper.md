# Pet-hazard discovery pipeline

`apps/scraper` is a scheduled ECS Fargate task (not a long-running service —
it wakes up, does one batch of work, exits) that turns **currently trending
pet-related search topics** into candidate rows on the existing moderation
queue. It **never writes a verified `Thing` directly** — every candidate lands
as a `pending`, unverified `Contribution` (same shape `apps/bff`'s own
`propose()` writes), so a human moderator always has to approve it through
the normal `ModerationPage` flow before it becomes real data.

There are no third-party API keys. Reddit access never shipped (the
Responsible Builder Policy blocked it); that client is gone. Discovery,
search, and "have we already collected this?" all go through Amazon Bedrock
AgentCore, authenticated by the Fargate task role.

## How it works

1. **Topic discovery** — AgentCore Browser (managed Chrome) + Playwright CDP
   opens Google Trends **Trending Now**, filtered to Pets and Animals:

   `https://trends.google.com/trending?geo=US&hours=24&category=13`

   (`category=13` is Pets and Animals.) That page is not covered by Trends'
   `robots.txt` disallow (only `/explore` is). The official Google Trends API
   is still a gated alpha and is **not** used; `TrendSource` in
   `apps/scraper/src/trends/types.ts` is the slot to drop an API client into
   later if that alpha opens up.

2. **Skip already-collected topics** — two layers:
   - Exact-term DynamoDB marker (`PK: SCRAPERTREND#{normalized term}`).
   - AgentCore Memory semantic retrieve in `/scraper/btfp-scraper`, so a
     near-duplicate of something we already researched is not re-searched
     (and not re-billed at $7/1,000 Web Search queries).

3. **Search** — AgentCore Gateway Web Search tool (`connectorId: web-search`).
   Queries never leave AWS; no search-vendor key. Default query shape:
   `{topic} toxic for dogs cats pets` (200-character cap).

4. **Classify** — Bedrock (`us.anthropic.claude-haiku-4-5-20251001-v1:0`,
   same forced-tool-use pattern as `BedrockClassifierService`) extracts
   `{ isPetHazardReport, thingName, thingTypeId, petTypeId, severity, summary }`.
   `thingTypeId`/`petTypeId` are constrained to whatever actually exists in
   the Content table at run time (a live `Scan`).

5. **Queue** — a matching name attaches to an existing Thing; otherwise the
   candidate proposes a new one. Then the topic is marked processed and
   written into AgentCore Memory.

## Configuration

Baked into the Fargate task definition by `infra/cdk/lib/scraper-stack.ts`
(no SSM secrets):

| Env var | Default | Purpose |
|---|---|---|
| `AGENTCORE_GATEWAY_URL` | Gateway `GatewayUrl` | MCP endpoint for Web Search |
| `AGENTCORE_MEMORY_ID` | Memory `MemoryId` | Long-term "already collected" store |
| `TRENDS_GEO` | `US` | Trends geo |
| `TRENDS_HOURS` | `24` | Trends window (4 / 24 / 48 / 168) |
| `TRENDS_CATEGORY` | `13` | Pets and Animals |
| `MAX_TOPICS_PER_RUN` | `8` | Cost cap per 6h run |
| `MAX_SEARCH_RESULTS` | `5` | Hits per topic |

Schedule is `events.Schedule.rate(...)` in `scraper-stack.ts`, currently
every 6 hours.

If `AGENTCORE_GATEWAY_URL` is empty the task logs a skip line and exits 0
— same fail-open the old Reddit-credential gate used, so a half-deployed
stack does not crash-loop.

## Dedup keys

- `PK: SCRAPERTREND#{normalized term}, SK: META` — exact topic already
  processed. Delete this item to force that term to be researched again.
- AgentCore Memory records under `/scraper/btfp-scraper` — semantic near-
  duplicates. These extract asynchronously after `CreateEvent`; the Dynamo
  marker is what stops the *next* run immediately.

## Manually triggering a run

Outside the 6h schedule, use the cluster/task-definition ARNs from the
`Scraper` stack's `CfnOutput`s (`ClusterArn`, `TaskDefinitionArn`):

```bash
aws ecs run-task \
  --cluster <ClusterArn> \
  --task-definition <TaskDefinitionArn> \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<public-subnet-id>],assignPublicIp=ENABLED}"
```

Watch progress via CloudWatch Logs (`/aws/ecs/...`, log group from the
stack).

## Testing

Unit tests (`pnpm --filter @btfp/scraper test`) mock AgentCore Gateway
HTTP, AgentCore Memory, Bedrock, DynamoDB, and the Trends browser session.
They cover query parsing, MCP result shapes, and that the written
`Contribution` item exactly matches `contributions.service.ts`'s key shape
— a mismatch there means candidates silently vanish from the moderation
queue with no visible error anywhere.

Before a first deploy of this rewrite to `BtfpDev`, run the task once
manually and confirm a real candidate shows up on the (Basic-Auth-walled)
dev site's `ModerationPage`, with a working `sourceUrl` back to a web
result. Only deploy to `BtfpProd` after that's confirmed and at least one
real moderator review of a scraper-produced candidate has happened in dev.
