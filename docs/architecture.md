# Architecture

BFF pattern: `apps/web` never talks to AWS directly. It calls `apps/bff`, which is the only
thing that touches DynamoDB, OAuth providers, and issues sessions.

```
apps/web (Vite/React)  --/api/*-->  CloudFront  --> apps/bff (NestJS, one Lambda)
                                       |                    |
                                       +--> S3 (static)     +--> DynamoDB (Content, Users)
```

One CloudFront distribution serves both: the default behavior serves the built React app
from S3, and `/api/*` is routed to an API Gateway HTTP API in front of the BFF Lambda's
`live` alias (SAM `AutoPublishAlias`; prod canaries, see [ci-cd.md](ci-cd.md)). This means the
frontend and API share an origin in every environment (no CORS to think about in prod), and
WAF at the CloudFront layer covers both.

## Why these choices

- **Lambda + HTTP API over Fargate/ALB** — scales to zero, no idle cost. At low/unknown
  traffic this stays close to free; an ALB + always-on Fargate task would burn a chunk of
  the $50/mo budget just sitting idle. See [infra.md](infra.md) for the breakdown.
- **Single Lambda for the whole BFF** — NestJS boots once per warm instance and handles all
  routes internally via Fastify. Simpler to reason about than one Lambda per route, and
  cold starts are acceptable at this traffic level.
- **DynamoDB single-table design** — see [data-model.md](data-model.md).
- **In-memory search instead of a managed search service** — the dataset is ~1,000 rows;
  scanning and searching in memory is free and fast at this scale. Revisit if it grows.

## Data flow for a search

1. Browser calls `GET /api/things?q=...&petType=...`.
2. `ThingsController` delegates to `SearchService`, which caches a full table scan (60s TTL)
   and runs a fuzzy search (`fuse.js`) over it in memory.
3. Result is a plain array of `Thing` (see `packages/shared-types`), rendered as
   `ThingCard`s.

## Data flow for a contribution

1. User signs in via GitHub OAuth (`AuthModule`) — see
   [verification-flow.md](verification-flow.md) for why GitHub specifically and how the
   quiz gate works.
2. Verified users `POST /api/contributions`. Identity matching
   (`planContributionAttach` in `packages/shared-types`) is shared by the BFF and the
   scraper: an explicit `thingId`, else a catalog match (`SearchService.findDuplicate`),
   else an already-pending queue row. A match **accumulates** new payload fields onto
   that pending row (`mergeThingPayload`) instead of inserting another card. A miss
   writes a pending item under the target Thing's partition (or a fresh id) — never
   directly to the live item.
3. `GET /api/contributions/pending` clusters leftover duplicates of the same identity
   into one card. `POST /api/contributions/:thingId/:sk/approve` folds sibling pending
   payloads into the live `Thing` (`mergeThings`) and marks those rows approved.
   Dynamo access for the queue goes through `PendingContributionStore` (Dynamo adapter
   in the BFF; the scraper talks to the table directly but uses the same shared-types
   plan). There's no admin-role check yet — see the note in
   `contributions.controller.ts`.
