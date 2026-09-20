/**
 * Hand-maintained summary of the app fed to the generator's Bedrock prompt.
 * The generator also captures a live ariaSnapshot() of each route so the
 * model isn't guessing at selectors, but it has no way to infer things that
 * aren't visible in a snapshot of the unauthenticated, unverified state —
 * the auth/verification test-only endpoints in particular. Keep this in
 * sync with apps/bff/src/auth/auth.controller.ts and
 * docs/verification-flow.md when either changes.
 */
export const APP_CONTEXT = `
Routes: "/" (search/browse things), "/submit" (contribute a new thing),
"/moderation" (review queue, requires verifiedContributor), "/things/:id"
(thing detail page).

IMPORTANT — the crawled ariaSnapshot()s below are captured logged-out and
unverified, since the crawler can't authenticate. /submit and /moderation
render completely different content once signed in and verified — the
snapshot of them is just a "please sign in" prompt, NOT the real form or
queue. Do not invent selectors for the authenticated view from that
snapshot; use the exact structural notes below instead, which describe the
real authenticated-state markup by hand.

Auth: three sign-in paths exist (GitHub OAuth, Google OAuth, work-email
sign-in via EmailSignInDialog), but only the email path is scriptable in an
automated test — the OAuth paths need a real third-party login.

The "Sign in with work email" element in the nav IS the dialog trigger
itself — there is no separate outer "Sign in" button to click first. One
click on it (getByRole('button', { name: /sign in with work email/i })) opens
the dialog directly.

To sign in in a generated test:

1. Click "Sign in with work email", then fill the email input with
   page.getByPlaceholder('you@yourclinic.org') — NOT getByRole('textbox',
   { name: /email/i }). Neither this input nor the code input in step 3 has
   a <label> or aria-label; each one's accessible name is just its
   placeholder text, so a role query matching on "email" won't find
   anything and will time out. Click "Send code" once filled.
2. IMPORTANT — race condition: clicking "Send code" doesn't wait for the
   underlying POST /api/auth/email/request to actually finish (Playwright's
   .click() only waits for the click itself, not any async work it
   triggers), and the code isn't written to the database until that request
   completes. Calling the test-code endpoint immediately after the click can
   read before it's written. Wait for the UI to confirm the request
   finished first — e.g. await
   expect(page.getByPlaceholder('123456')).toBeVisible({ timeout: 15000 })
   (the dialog only reaches its second step after the request succeeds) —
   THEN call GET /api/auth/email/test-code?email=<address> to fetch the
   code. This endpoint only exists outside prod and only returns a code
   while one is pending. Use it instead of trying to read a real inbox.
   IMPORTANT — this specific request is genuinely slow, not just
   click-to-render UI latency: it does a synchronous Bedrock classification
   call plus an SES send, timed at ~2.5s even on a warm Lambda, and CI runs
   this right after a fresh deploy where the Lambda is cold-starting for
   the first time too. Playwright's default expect timeout (5000ms) is not
   enough margin — always pass an explicit longer timeout (15000ms+) on
   this specific assertion, not the default.
3. Fill the now-visible page.getByPlaceholder('123456') input with the
   fetched code and click "Sign in" — the response sets an httpOnly session
   cookie and the dialog closes.

IMPORTANT — cookie sharing: for ANY authenticated API call after sign-in
(test/verify below in particular), use page.request, not the bare request
fixture. The bare request fixture is its own separate APIRequestContext
with its own cookie jar — it does NOT see the session cookie the browser
just received from signing in through the UI. page.request shares the
browser context's cookies, so it does. The test-code call above doesn't
need this (that endpoint is unauthenticated), but test/verify does.

Use a unique email per test run at our own domain, e.g.
\`e2e-\${Date.now()}@badthingsforpets.com\` — badthingsforpets.com has real MX
records (see docs/infra.md), so sends to it succeed even while the account's
SES is in sandbox mode (which rejects sends to addresses at domains with no
mail setup at all, e.g. example.com). A unique address per run avoids test
collisions without needing a fixed shared account. (Only john@/info@ at that
domain actually forward to a real inbox — not catch-all — but that doesn't
matter here since the test-code endpoint reads the code straight from the
database, never the inbox.)

Verification: a brand-new signed-in user has verifiedContributor: false and
cannot submit things. On prod they also cannot see the moderation queue; on
non-prod, a signed-in session is enough for the contribution queue (the page
also POSTs /api/auth/test/verify so organization reviews unlock). Two real
paths exist (a
pop quiz with randomized answers, or a slower human-reviewed professional
path) but neither is scriptable deterministically. Instead, call POST
/api/auth/test/verify (authenticated, i.e. after completing email sign-in
above — the session cookie carries it) to mark the current session's user
as verifiedContributor directly, then reload the page. This endpoint also
only exists outside prod.

/submit form (only rendered once verifiedContributor — reload after the
test/verify call above before navigating here), in order:
- "Name" — text input, getByLabel(/^name$/i)
- "Type" — a real <select> (getByRole('combobox', { name: /type/i })),
  options: plant, food, medication, product, activity. The option elements'
  actual text content is lowercase ("food", not "Food") — any capitalization
  visible on screen is CSS text-transform, not real DOM text, and
  selectOption's label match is against the real DOM text. Use
  selectOption('food') (matches by value, which is also lowercase) — don't
  use selectOption({ label: 'Food' }), the capital F won't match anything.
- "Dangerous for" — a checkbox group (NOT radio, NOT a select), one
  checkbox per pet type: getByRole('checkbox', { name: /^dog$/i }),
  /^cat$/i, /^horse$/i. "dog" is checked by default.
- "Why is it dangerous?" — a required textarea,
  getByLabel(/why is it dangerous/i)
- "Source (optional)" — a text input, getByLabel(/source/i)
- Submit button: getByRole('button', { name: /submit for review/i })
- On success, the page shows a confirmation screen with heading "Thanks! 🐾"
  and text "Your submission is in the moderation queue for review." — assert
  with getByRole('heading', { name: /^thanks!/i }) (omit the emoji; accessible
  names vary) and the exact queue text. Wait for POST /api/contributions to
  finish before asserting — the handler scans the catalog for duplicates.

/moderation page: each pending item has "Approve" and "Reject" buttons
(getByRole('button', { name: /^approve$/i }) / /^reject$/i). Reject triggers
a native browser prompt() for an optional reason — Playwright needs a
page.on('dialog', ...) handler registered before clicking Reject, or the
test will hang waiting on it.

General conventions: prefer Playwright's role/label-based locators
(getByRole, getByLabel, getByText) over CSS selectors, matching what's in
the provided ariaSnapshot() for the logged-out pages. Don't use hard-coded
waits (page.waitForTimeout) — use Playwright's built-in auto-waiting
assertions instead. Import from '@playwright/test'.
`.trim();
