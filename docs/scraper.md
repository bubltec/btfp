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

1. **Topic discovery** — two sources, merged and de-duplicated:
   - **Trending Now** — AgentCore Browser (managed Chrome) + Playwright CDP opens
     `https://trends.google.com/trending?geo=US&hours=24` and reads the trend rows.
     The page ignores `category=13` (it always shows all categories), and the
     list is mostly sports and news, so every term goes through a **triage** step
     (`extract/triage.ts`): the model gives a yes/no per topic on "could this
     poison a dog or cat", and only the yeses continue. If the page yields no rows the
     source **throws** (it used to fall back to scraping every link, which turned the
     footer — "Terms", "Privacy", "Sign in" — into "trends"); the run logs the outage
     and carries on with search discovery. `/explore` is disallowed by Trends'
     `robots.txt` and is not used. The official Trends API is still a gated alpha;
     `TrendSource` in `apps/scraper/src/trends/types.ts` is the slot for it.
   - **Search discovery** (`discover/seed-search.ts`) — a fixed list of hazard-news
     queries ("new toxic substance dogs veterinarians warn this week", …) run through
     the web-search tool; the model lists the specific substances the results name.
     This is the source that actually finds toxic items.

2. **Skip already-collected topics** — two layers:
   - Exact-term DynamoDB marker (`PK: SCRAPERTREND#{normalized term}`).
   - AgentCore Memory semantic retrieve in `/scraper/btfp-scraper`, so a
     near-duplicate of something we already researched is not re-searched
     (and not re-billed at $7/1,000 Web Search queries).

3. **Research** (`research.ts`) — AgentCore Gateway Web Search tool
   (`connectorId: web-search`), three queries per topic (toxic to dogs, toxic to cats,
   symptoms/treatment), merged and de-duplicated by URL (max 10 hits) so the
   classifier sees independent sources. Queries never leave AWS; no search-vendor key.

4. **Classify** — Bedrock (`us.anthropic.claude-sonnet-4-6`; `SCRAPER_BEDROCK_INFERENCE_PROFILE_ID`
   in `infra/cdk/lib/config.ts`, deliberately stronger than the BFF's Haiku), forced tool
   use, temperature 0, with a system prompt that requires: only facts in the sources,
   one specific named hazard (never a list or category), a severity per pet type actually
   discussed, and a `confidence` of high/medium/low (two independent authoritative
   sources = high). Output: `{ isPetHazardReport, thingName, thingTypeId, petTypes[],
summary, confidence }`. `thingTypeId`/`petTypeId` are constrained to what exists in the
   Content table (a live `Scan`). The model sees the topic and the numbered search
   results — nothing else.

5. **Queue** — only reports with a name, a type and confidence above `low` are filed
   (`isFileableExtraction`); a matching name attaches to an existing Thing, otherwise the
   candidate proposes a new one. `confidence` is stored in `details` for the moderator.
   Then the topic is marked processed and written into AgentCore Memory.

## Configuration

Baked into the Fargate task definition by `infra/cdk/lib/scraper-stack.ts`
(no SSM secrets):

| Env var                 | Default              | Purpose                             |
| ----------------------- | -------------------- | ----------------------------------- |
| `AGENTCORE_GATEWAY_URL` | Gateway `GatewayUrl` | MCP endpoint for Web Search         |
| `AGENTCORE_MEMORY_ID`   | Memory `MemoryId`    | Long-term "already collected" store |
| `TRENDS_GEO`            | `US`                 | Trends geo                          |
| `TRENDS_HOURS`          | `24`                 | Trends window (4 / 24 / 48 / 168)   |
| `TRENDS_CATEGORY`       | `13`                 | Pets and Animals                    |
| `MAX_TOPICS_PER_RUN`    | `8`                  | Cost cap per 6h run                 |
| `MAX_SEARCH_RESULTS`    | `5`                  | Hits per topic                      |

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
  marker is what stops the _next_ run immediately.

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
