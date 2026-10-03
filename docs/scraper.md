# Pet-hazard discovery pipeline

`apps/scraper` is an ECS Fargate task (not a long-running service — it wakes up, does
one batch of work, exits) that turns **trending pet-related search topics, hazard news
and model-suggested gaps in the catalog** into candidate rows on the existing moderation
queue. It runs once a week in prod and only when started by hand in dev. It **never writes a verified `Thing` directly** — every candidate lands
as a `pending`, unverified `Contribution` (same shape `apps/bff`'s own
`propose()` writes), so a human moderator always has to approve it through
the normal `ModerationPage` flow before it becomes real data.

There are no third-party API keys. Reddit access never shipped (the
Responsible Builder Policy blocked it); that client is gone. Discovery,
search, and "have we already collected this?" all go through Amazon Bedrock
AgentCore, authenticated by the Fargate task role.

## How it works

1. **Topic discovery** — two sources, merged and de-duplicated (a third, model
   suggestions, fills in when these find nothing new: step 3):
   - **Trending Now** — AgentCore Browser (managed Chrome) + Playwright CDP opens
     `https://trends.google.com/trending?geo=US&hours=24` and reads the trend rows.
     The page ignores `category=13` (it always shows all categories), and the
     list is mostly sports and news, so every term goes through a **triage** step
     (`extract/triage.ts`): the model gives a yes/no per topic on "could this
     poison a dog or cat", and only the yeses continue. Only terms that were never judged
     go to the model; the ones it rules out get a marker (`outcome: triaged_out`), so a
     trend list that has not changed costs no model call. If the page yields no rows the
     source **throws** (it used to fall back to scraping every link, which turned the
     footer — "Terms", "Privacy", "Sign in" — into "trends"); the run logs the outage
     and carries on with search discovery. `/explore` is disallowed by Trends'
     `robots.txt` and is not used. The official Trends API is still a gated alpha;
     `TrendSource` in `apps/scraper/src/trends/types.ts` is the slot for it.
   - **Search discovery** (`discover/seed-search.ts`) — a fixed list of hazard-news
     queries ("new toxic substance dogs veterinarians warn this week", …) run through
     the web-search tool; the model lists the specific substances the results name.
     This is the source that actually finds toxic items. Each query remembers the result
     URLs it has seen (`discover/seed-state.ts`). A run that returns no new URL skips the
     extraction and backs the query off, doubling from 12h up to a week, so a query stuck
     on the same pages stops costing a search on every run. Any new URL resets it.

2. **Skip what is not new** — cheapest check first, and every skip leaves a marker so the
   next run stops at the first check:
   - Exact-term DynamoDB marker (`PK: SCRAPERTREND#{normalized term}`).
   - The term is already a catalog entry, by name or alias (`outcome: in_catalog`). Gaps in
     existing entries are step 7's job.
   - AgentCore Memory (`novelty.ts`): the three most similar earlier topics are recalled.
     The same normalized term or hazard name is a duplicate outright; nothing similar
     enough (score under `SIMILARITY_FLOOR`) is new. What is left ("Advil" next to a
     remembered "ibuprofen", "tea" next to "tea tree oil") goes to the model in **one**
     call for the whole run, with the recalled records as context. A duplicate is logged
     and marked (`outcome: duplicate`, `duplicateOf`); if the call fails, everything is
     treated as new.

3. **Suggest topics when discovery leaves room** (`discover/ideate.ts`) — up to
   `MAX_IDEAS_PER_RUN` of the run's slots. Each run takes the next thing-type and pet-type
   pair (plants and cats, medications and dogs, …; the position is stored in
   `SCRAPERIDEA#CURSOR`) and asks the model for specific hazards of that kind that are not
   covered. "Covered" is the catalog's entries of that type plus what memory recalls for
   that pair, which includes topics that were researched and turned down. The model only
   proposes names. Each one goes through step 2, is researched and classified from web
   sources like any other topic, and still needs a moderator.

4. **Research** (`research.ts`) — AgentCore Gateway Web Search tool
   (`connectorId: web-search`), three queries per topic (toxic to dogs, toxic to cats,
   symptoms/treatment), merged and de-duplicated by URL (max 10 hits) so the
   classifier sees independent sources. Queries never leave AWS; no search-vendor key.

5. **Classify** — Bedrock (`us.anthropic.claude-sonnet-4-6`; `SCRAPER_BEDROCK_INFERENCE_PROFILE_ID`
   in `infra/cdk/lib/config.ts`, deliberately stronger than the BFF's Haiku), forced tool
   use, temperature 0, with a system prompt that requires: only facts in the sources,
   one specific named hazard (never a list or category), a severity per pet type actually
   discussed, and a `confidence` of high/medium/low (two independent authoritative
   sources = high). Output: `{ isPetHazardReport, thingName, thingTypeId, petTypes[],
summary, confidence }`. `thingTypeId`/`petTypeId` are constrained to what exists in the
   Content table (a live `Scan`). The model sees the topic and the numbered search
   results — nothing else.

6. **Queue** — only reports with a name, a type and confidence above `low` are filed
   (`isFileableExtraction`); a matching name attaches to an existing Thing, otherwise the
   candidate proposes a new one. `confidence` is stored in `details` for the moderator.
   Then the topic is marked processed (with its outcome) and remembered: one memory record
   with the term, the hazard the classifier named, the outcome and the summary.

7. **Enrich existing entries** (`enrich.ts`) — whatever part of `MAX_TOPICS_PER_RUN` new
   and suggested topics didn't use goes to catalog Things with no known severity for some pet type
   (`unknown` or missing). Dog and cat gaps come first, then entries with the most gaps.
   Research asks about exactly the missing pet types, and the classifier is told which
   ones it is filling in. A contribution is filed against that Thing, under its own name
   and type, only when the result gives a known severity for a missing pet type at
   confidence above `low`. Every attempt writes `PK: SCRAPERENRICH#{thingId}`, and an
   entry is not retried for 30 days.

## Memory

One record per researched topic, in the namespace `/researched/btfp-scraper/`, written
with `BatchCreateMemoryRecords` and searched with `RetrieveMemoryRecords`
(`memory/agentcore.ts`). The term, hazard name and outcome are metadata on the record.

The scraper does **not** send events (`CreateEvent`). It used to, and the memory's semantic
strategy rewrote them into merged summaries ("…researching toxic foods (chocolate, grapes,
xylitol, …)"). A topic was then "already collected" if its name appeared anywhere in a
recalled summary, so "permethrin" or "tea" would be skipped because another topic's
summary mentioned the word, while which summaries came back varied from run to run. Each
event also cost an extraction call. Those old summaries are still in `/scraper/btfp-scraper/`
and are never read.

Records created before this format exist only as `SCRAPERTREND#` markers. To give memory a
record for each of them, start the task once with `SCRAPER_BACKFILL_MEMORY=1` (see
"Starting a run by hand"). It can be run again; terms memory already holds are left alone.

## Configuration

Baked into the Fargate task definition by `infra/cdk/lib/scraper-stack.ts`
(no SSM secrets). The per-environment values are `EnvConfig.scraper` in
`infra/cdk/lib/config.ts`.

| Env var                 | Dev / prod           | Purpose                                    |
| ----------------------- | -------------------- | ------------------------------------------ |
| `AGENTCORE_GATEWAY_URL` | Gateway `GatewayUrl` | MCP endpoint for Web Search                |
| `AGENTCORE_MEMORY_ID`   | Memory `MemoryId`    | What has already been researched           |
| `TRENDS_GEO`            | `US`                 | Trends geo                                 |
| `TRENDS_HOURS`          | `24` / `168`         | Trends window (4 / 24 / 48 / 168)          |
| `TRENDS_CATEGORY`       | `13`                 | Pets and Animals                           |
| `MAX_TOPICS_PER_RUN`    | `8` / `24`           | Topics + enrichments per run               |
| `MAX_IDEAS_PER_RUN`     | `3` / `8`            | Of those, how many may be model-suggested  |
| `MAX_SEARCH_RESULTS`    | `5`                  | Hits per topic                             |

Schedule: prod runs Mondays at 14:00 UTC (`events.Schedule.cron` in `scraper-stack.ts`).
Dev has no schedule.

If `AGENTCORE_GATEWAY_URL` is empty the task logs a skip line and exits 0
— same fail-open the old Reddit-credential gate used, so a half-deployed
stack does not crash-loop.

## Dedup keys

- `PK: SCRAPERTREND#{normalized term}, SK: META` — a term that will not be looked at
  again. `outcome` says why: `filed`, `not_hazard`, `unusable`, `no_hits` (researched),
  `triaged_out` (a trend the model ruled out), `in_catalog`, or `duplicate` (with
  `duplicateOf`). Delete this item to have the term considered again.
- `PK: SCRAPERSEED#{normalized query}, SK: META` — a discovery query's seen URLs and
  backoff. Delete it to search that query again next run.
- `PK: SCRAPERENRICH#{thingId}, SK: META` — last enrichment attempt for a Thing and its
  outcome. Delete it to retry that Thing before the 30 days are up.
- `PK: SCRAPERIDEA#CURSOR, SK: META` — which thing-type and pet-type pair the last run
  asked for suggestions in.
- AgentCore Memory records under `/researched/btfp-scraper/` — see "Memory". Records are
  searchable a few seconds after they are written; the Dynamo marker is what stops an
  exact repeat immediately.

## Starting a run by hand

This is the only way dev runs. Use the `Scraper` stack's outputs (`ClusterArn`,
`TaskDefinitionArn`, `PublicSubnetIds`):

```bash
aws ecs run-task \
  --cluster <ClusterArn> \
  --task-definition <TaskDefinitionArn> \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<one of PublicSubnetIds>],assignPublicIp=ENABLED}"
```

For the one-off memory backfill, add:

```bash
  --overrides '{"containerOverrides":[{"name":"scraper","environment":[{"name":"SCRAPER_BACKFILL_MEMORY","value":"1"}]}]}'
```

Watch progress via CloudWatch Logs (`/aws/ecs/...`, log group from the
stack). The last line of a run says how many topics were researched, how many of those
the model suggested, and how many were skipped for each reason.

## Testing

Unit tests (`pnpm --filter @btfp/scraper test`) mock AgentCore Gateway
HTTP, AgentCore Memory, Bedrock, DynamoDB, and the Trends browser session.
They cover query parsing, MCP result shapes, the skip rules and the duplicate check, topic
suggestion, and that the written
`Contribution` item exactly matches `contributions.service.ts`'s key shape
— a mismatch there means candidates silently vanish from the moderation
queue with no visible error anywhere.

Before a first deploy of this rewrite to `BtfpDev`, run the task once
manually and confirm a real candidate shows up on the (Basic-Auth-walled)
dev site's `ModerationPage`, with a working `sourceUrl` back to a web
result. Only deploy to `BtfpProd` after that's confirmed and at least one
real moderator review of a scraper-produced candidate has happened in dev.
