# Verification flow

Goal: let people contribute without a heavyweight account-registration flow, while keeping
out low-effort spam/vandalism. Two independent paths to `verifiedContributor: true`, either
of which unlocks contributing.

## Path 1: quiz

1. **GitHub OAuth sign-in, with an account-age check.** GitHub's `/user` API exposes a
   public `created_at` for the account, which Google's OAuth does not — that's why GitHub
   is the qualifying provider and Google (also supported) is browsing/favoriting only.
   `MIN_ACCOUNT_AGE_DAYS` (default 30, see `.env.example`) sets the minimum age.
2. **A three-question pop quiz**, generated from real seeded Things (`VerificationService`)
   against real ASPCA-listed safe plants as distractors (`quiz-bank.ts`). Framed as fun,
   not a form — see `QuizDialog.tsx`. Must pass all three to unlock contributing.

## Path 2: professional (organizational email)

For vets and scientists — proves you control an organizational email, doesn't assume
you have (or want) a GitHub or Google account. Two entry points into the same
underlying mechanism (`apps/bff/src/auth/email-code.service.ts`):

- **Standalone sign-in**, no prior account needed: `POST /auth/email/request` +
  `/auth/email/confirm` (`AuthController`, unauthenticated). Confirming the code creates a
  new `User` (`provider: 'email'`, keyed by the address itself —
  `UsersService.findOrCreateByEmail`) and issues a session, same as finishing a GitHub
  OAuth login. `EmailSignInDialog.tsx` in the frontend.
- **Add-on to an existing session**: someone already signed in via GitHub/Google can layer
  org verification onto that same account instead — `POST /verification/professional/request`
  + `/confirm` (`ProfessionalVerificationController`, requires `JwtAuthGuard`). Delegates to
  the identical underlying service. `ProfessionalVerificationDialog.tsx` in the frontend.

Either way, the mechanism itself:

1. **Domain gate**: the claimed email's domain must not be a personal/free provider
   (`free-email-domains.ts` — a hardcoded blocklist, not an npm package, so it's auditable),
   must resolve real MX records, and is rate-limited to one code per minute
   (`UsersService.canRequestNewCode`) to make the public, unauthenticated request endpoint
   harder to use as a spam vector.
2. **Evidence gathering + Bedrock classification**: rather than guessing from the bare
   domain string, two real-evidence signals are gathered first and handed to Claude Haiku
   (`bedrock-classifier.service.ts`, Converse API, forced tool-call output):
   - `homepage-fetcher.service.ts` fetches the domain's own homepage (`https://domain`,
     falling back to `https://www.domain`) server-side and strips it to plain text. It's an
     SSRF-safe fetch: DNS is resolved and validated up front (rejects private/loopback/
     link-local addresses, including the cloud metadata endpoint), the connection is pinned
     to that validated IP rather than re-resolving at connect time (closes the DNS-rebinding
     TOCTOU gap), and redirects/response size/timeout are all capped.
   - `search-history.service.ts` queries the domain via the **Brave Search API** (not
     scraping search-results pages — that's a ToS violation for Google/Bing and something
     their bot defenses actively block anyway) for independent evidence the organization
     has some history (directory listings, news mentions, review sites). Optional: if
     `BRAVE_SEARCH_API_KEY` isn't set, this signal is silently skipped.

     Started as Google's Custom Search JSON API, but Google has closed that API to new
     customers (deprecated for anyone without prior access, migration deadline
     2027-01-01) — confirmed via Google's own support forum after every plausible
     configuration mistake was ruled out (project/key match, API actually enabled,
     billing linked, unrestricted fresh key, disable/re-enable cycle). Brave needs no
     GCP project or billing account.

     Also checked whether Bedrock itself could do this natively instead of calling a
     search API ourselves: the plain Converse API can't — verified empirically (a
     `ConverseCommand` with `additionalModelRequestFields: { tools: [{ type:
     "web_search_20250305", ... }] }` gets rejected with a `ValidationException` whose
     error message enumerates every tool type Bedrock's hosted Claude models actually
     accept, and none of them are a `web_search` variant). AWS did announce a *separate*
     product, **Web Search on Amazon Bedrock AgentCore** (2026-06-17), which does do
     this — but as an MCP connector through AgentCore Gateway, a different service
     surface that would mean standing up a Gateway resource and restructuring this
     single forced-tool-choice classification call into a multi-turn agent loop. Not
     worth it for one assistive signal; worth reconsidering if this app ever grows a
     broader agent architecture.

   Claude Haiku then classifies what kind of org the domain looks like (veterinary clinic,
   university/research, etc.) and its reasoning references whichever evidence was actually
   available. This is still **assistive only, never a gate** — even grounded in real
   evidence, an LLM's read of a homepage and some search snippets can't *prove* an
   organization is real or that the applicant works there; a human reviewer makes the actual
   call. If Bedrock or either evidence source is unavailable, verification proceeds without
   that signal rather than blocking.
   **Requires a one-time manual step**: AWS/Anthropic require submitting a "use case
   details" form for the account before Anthropic models on Bedrock will actually respond —
   until that's done, `bedrock:InvokeModel` calls fail and classification is silently
   skipped (the gate above still works fine without it).
3. **Proof of ownership**: a 6-digit code (SHA-256 hashed at rest, 15-minute expiry) is
   emailed via SES to the claimed address. Confirming it moves status to
   `awaiting_review` — proves the person controls the inbox, but doesn't yet grant anything.
4. **Human review**: any verified contributor can see the queue (domain + Bedrock's guess,
   not the full email — keeps the local-part private from reviewers) at
   `GET /verification/professional/pending` and approve/reject it. Same
   "any verified contributor can moderate" pattern as contribution review — see the gap
   noted below. `HydratingUsersService` sanitizes this list: mycota strips PK, and some
   older rows never stored `id`, which produced
   `POST /verification/professional/undefined/review`. Missing identity is backfilled
   from `USER#provider#accountId` before the mycota review path runs.

Approving sets `verifiedContributor: true` (same unlock as the quiz) and, on any
contribution later approved from that user, stamps `details.verifiedOrgDomain` on the
resulting `Thing` (`ContributionsService.approve`) — shown as a badge on
`ThingDetailPage`.

**SES starts in sandbox mode** — can only send to individually-verified recipient
addresses. Moving to production access is an AWS Support request via the console, not
automatable. See `docs/infra.md`.

## A bug worth knowing about (fixed)

The session JWT's `verifiedContributor` claim is set once at sign-in and was never
reissued when the quiz was passed or a professional verification approved — the latter
can even happen from a *different* browser session (the reviewer's), so there was no way
to refresh the approved user's own cookie at that moment anyway. `VerifiedGuard` and
`GET /auth/me` now re-check the live DB record instead of trusting the JWT's cached claim
(`UsersService.getByProviderAccount` on every guarded request). Costs an extra DynamoDB
read per request — negligible at this scale, and it closes a real staleness gap: without
it, a user who passed the quiz would appear "not verified" until they logged out and back
in, and a revoked/rejected user's stale token would still pass the old guard.

## Known simplifications (MVP)

- The quiz is regenerated and graded per attempt with no persistence or rate limiting —
  someone could brute-force it by resubmitting. Fine for a launch-scale spam deterrent, not
  bulletproof.
- `GET /contributions/pending` and `GET /verification/professional/pending` are both
  gated on `verifiedContributor` only, with no separate admin role. Add an allowlist
  before opening contributions up publicly.
- Session is a long-lived (30-day) JWT in an httpOnly cookie. The *contributor gate* is now
  live-checked (see above), but identity itself still can't be revoked before the token
  expires — rotating `JWT_SECRET` invalidates all sessions if you need a hard reset.
- Org-email ownership proves someone works there, not that they're specifically a vet or
  scientist (could be anyone at that domain). Labeled as "verified organization," not
  "verified veterinarian," on purpose.

## Setting up real OAuth credentials

Register OAuth apps at GitHub (Settings → Developer settings → OAuth Apps) and, if you want
Google sign-in too, Google Cloud Console. Set the client id/secret and callback URLs in
`apps/bff/.env` (copy from `.env.example`). Callback URLs must match exactly what's
registered with each provider.

## Setting up the Brave Search signal (optional)

1. Sign up at [brave.com/search/api](https://brave.com/search/api/) and create an API key —
   no Google Cloud project or billing account needed, unlike the Google Custom Search API
   this replaced (see the note in [Path 2](#path-2-professional-organizational-email) above
   for why that one was abandoned).
2. Set `BTFP_BRAVE_SEARCH_API_KEY` in `infra/cdk/.env.deploy.local` (gitignored — never
   commit real values), then redeploy `BtfpDev/Api` (and `BtfpProd/Api` once that stage
   exists) to pick it up.

Note that `/auth/email/request`'s rate limit (`UsersService.canRequestNewCode`) is 1
request/minute *per email address*, not global, so it doesn't by itself cap total daily
search volume — worth knowing if you ever see unexpected Brave billing. Leaving the env var
unset just skips this evidence signal entirely; nothing else in the flow depends on it.
