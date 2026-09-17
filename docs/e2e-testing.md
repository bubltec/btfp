# E2E testing

`apps/e2e` generates real Playwright tests from a plain-English flow description, using
Bedrock Claude Sonnet grounded in a live accessibility snapshot of the app plus a
hand-maintained context doc — rather than writing Playwright scripts by hand or having an
LLM drive the browser live on every run (see the tradeoffs this ruled out, below).

## Running the generator

```bash
cd apps/e2e
BASE_URL=https://d11hklju47pzyo.cloudfront.net \
BASIC_AUTH_USER=dev \
BASIC_AUTH_PASSWORD=<dev's Basic Auth password> \
pnpm generate --prompt "Sign in with a work email, submit a new dangerous thing, verify it shows a confirmation." --name my-flow-name
```

`--name` must be kebab-case; the output lands at `tests/generated/<name>.spec.ts`. Review
the generated file before trusting it — it's LLM output, not guaranteed correct — then run
it:

```bash
pnpm test tests/generated/my-flow-name.spec.ts
```

`BASE_URL` defaults to `http://localhost:5173` (local dev). `BASIC_AUTH_USER`/`PASSWORD` are
only needed against the deployed dev stage, which is Basic-Auth-locked (see
[docs/infra.md](./infra.md)) — omit them for local or prod.

To run the same spec CI uses against dev (after `pnpm secrets:sync dev`, or with
`BASIC_AUTH_*` exported):

```bash
pnpm --filter @btfp/e2e test:dev
# or a single file:
pnpm --filter @btfp/e2e test:dev tests/generated/email-signin-submit-thing.spec.ts
```

## How it works

1. Launches a headless browser, navigates to a fixed set of routes (`/`, `/submit`,
   `/moderation` — good coverage for this app's small surface without needing a separate LLM
   call to decide what to crawl), and captures each page's `ariaSnapshot({ mode: 'ai' })`.
2. Sends the flow prompt + those snapshots + `scripts/app-context.ts` (hand-maintained notes
   on things the crawler can't see itself, below) to Bedrock via `ConverseCommand`, forcing a
   single-string tool-call response so the output is clean code with no markdown fences or
   prose to strip.
3. Writes the result straight to `tests/generated/<name>.spec.ts`.

## The test-only auth endpoints

Most useful flows need to be signed in, but sign-in normally needs a real emailed code or a
real GitHub/Google login — neither of which a non-interactive script can complete. Two
endpoints exist solely to unblock this, both gated to non-prod:

- `GET /auth/email/test-code?email=<address>` — returns the plaintext verification code
  issued for that address, read straight from the database rather than an inbox. The code is
  normally stored SHA-256 hashed at rest; the plaintext copy this reads is only ever written
  when `STAGE !== 'prod'` (see `UsersService.setProfessionalPending`), so the guarantee that
  it doesn't exist in prod holds even if the endpoint's own `STAGE` check were somehow
  bypassed.
- `POST /auth/test/verify` (authenticated) — marks the current session's user
  `verifiedContributor: true` directly, skipping the pop quiz (randomized correct answers
  per attempt, not scriptable) and the human-reviewed professional path (not deterministic on
  any useful timescale).

Both throw `NotFoundException` in prod — see `apps/bff/src/auth/auth.controller.ts`.

## Why the crawler can't just see the authenticated UI

`/submit` and `/moderation` render completely different content once signed in and verified
— the crawler only ever sees the logged-out "please sign in" version, since it has no way to
authenticate itself. `app-context.ts` compensates with hand-written, hand-verified notes on
the actual authenticated-state markup (exact selectors, known quirks like unlabeled inputs
whose accessible name comes from their placeholder, or `<select>` options whose real text is
lowercase despite looking capitalized on screen via CSS). Keep this file in sync with the
actual components — `SubmitPage.tsx`, `EmailSignInDialog.tsx`, `ModerationPage.tsx` — when
any of them change; stale notes here produce confidently wrong generated tests.

This isn't just a testing inconvenience — building the first real generated spec for this
app surfaced two genuine bugs in the process, found only because a real generated test
actually exercised the authenticated flow end-to-end:

- `SubmitPage.tsx` checked `professional?.status === 'awaiting_review'` before checking
  `verifiedContributor`, so a user who was already verified by some other means (e.g. the
  quiz) but still had an unrelated pending professional review got stuck on the "Almost
  there" screen instead of reaching the actual form.
- Several form fields (`Name`, `Type`, `Why is it dangerous?`, `Source`) had `<label>`
  elements with no `htmlFor`/`id` association with their inputs — invisible on screen, but it
  meant `getByLabel` (and real screen readers) couldn't associate the label with the field at
  all.

## Backend choice: Playwright, not AgentCore Browser or AgentCore Web Search

Two AWS-native alternatives were considered and ruled out for this in favor of what's here:

- **AgentCore Browser** (a managed, sandboxed cloud browser AWS added alongside AgentCore
  Gateway) would mean new AWS infra, IAM wiring, and building an agent loop from scratch, for
  a benefit (AWS-hosted execution) this project doesn't need — Playwright already runs free
  in CI or locally, consistent with this repo's minimal-infra bias throughout.
- **Bedrock's plain Converse API cannot do native web search or browser control** — verified
  empirically, not assumed: a `ConverseCommand` with `additionalModelRequestFields: { tools:
  [{ type: "web_search_20250305", ... }] }` gets rejected with a `ValidationException` whose
  error message enumerates every tool type Bedrock's hosted Claude models actually accept,
  and none of them are a `web_search`/browser-control variant, at any date. AWS does have a
  *different* product for this — Web Search on Amazon Bedrock AgentCore (2026-06-17) — but
  that's the same AgentCore Gateway path as above, with the same tradeoffs.

## Running in CI

Wired up: `.github/workflows/deploy.yml`'s `e2e` job runs `pnpm --filter @btfp/e2e test`
against the freshly-deployed `https://dev.badthingsforpets.com` after every push to `main`,
gating promotion to prod — see [docs/ci-cd.md](./ci-cd.md) for the full pipeline. Same
invocation documented above, just automated instead of run by hand.

Accepted tradeoff: the generated spec does a real `POST /submit` and a real email sign-up
against dev's actual DynamoDB tables, so every CI run permanently adds to dev's data. Not
cleaned up automatically — dev isn't a pristine/indexed dataset to begin with (see
[docs/infra.md](./infra.md#dev-is-not-public)); wipe/reseed it by hand if it gets noisy.
