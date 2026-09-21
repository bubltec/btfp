# SEO / AEO

## What's already in place

- `robots.txt` (prod only — dev is intentionally `Disallow: /`, see
  [docs/infra.md](./infra.md)) explicitly allows known AI crawlers by name
  (GPTBot, ClaudeBot, PerplexityBot, etc.) alongside `User-agent: *`.
- `/llms.txt` — a plain-language summary of the site and its API, written for
  LLMs/agents rather than humans.
- `/sitemap.xml` — every browsable URL, server-generated fresh on each
  request from live data (`apps/bff/src/sitemap/sitemap.controller.ts`), not
  a static file.
- `/api/openapi.json` — the full API contract, for anything that wants to
  call the API directly instead of scraping HTML.
- An MCP server at `/api/mcp` (`search_things`, `get_thing`, `list_pet_types`,
  `list_thing_types` tools) for MCP-aware clients.
- `/llm-info` — an in-app page (linked from the footer as "LLM Information")
  that explains all of the above for a human visitor, with links out to
  `/llms.txt`, `/api/openapi.json`, `/api/mcp`, and `/sitemap.xml`.
- schema.org JSON-LD via `apps/web/src/lib/useJsonLd.ts` (same imperative
  `<script>`-tag-upsert pattern as `useDocumentMeta.ts`, so it's picked up by
  the prerender crawl the same way): a site-wide `WebSite` schema (`App.tsx`)
  with a `SearchAction` pointing at `/?q={search_term_string}` — genuinely
  functional, since `HomePage.tsx` already drives its search off that query
  param via `useSearchParams()` — and an `Article` schema per thing
  (`ThingDetailPage.tsx`), reusing the same headline/description already
  computed for `useDocumentMeta`.

## The prerendering problem

This is a client-side-only React SPA — without the fix below, every route
serves the _same_ static HTML shell (generic title, generic description, an
empty `<div id="root">`), and the real content only appears after JavaScript
executes and fetches data. Plenty of crawlers, including some of the AI ones
`robots.txt` explicitly welcomes, fetch raw HTML without executing JS —
meaning they'd see nothing useful on any of the ~450 individual thing pages,
which is most of this site's actual value for both traditional search and
AEO (an LLM citing a specific fact needs that fact to actually be in the
page it fetched).

### The fix: build-time prerendering

`apps/web/scripts/prerender.mjs`, run as part of a prod deploy:

1. Fetches the current list of things from a real API (`PRERENDER_API_ORIGIN`,
   defaults to `https://badthingsforpets.com`).
2. Serves the already-built `dist/` locally via `vite preview` (which proxies
   `/api/*` to that same real API — see `preview.proxy` in `vite.config.ts`;
   `vite dev`'s proxy config doesn't carry over to `preview` automatically).
3. Crawls every route with Playwright, waits for the real content to render,
   and saves the resulting HTML as a real file at that exact path —
   `dist/things/<id>/<slug>/index.html`, `dist/submit/index.html`, etc. —
   instead of relying on client-side rendering at request time.

Run it after `vite build`, before deploying:

```bash
cd apps/web
pnpm build
PRERENDER_API_ORIGIN=https://badthingsforpets.com pnpm run prerender
# then deploy BtfpProd/Web as usual — cdk uploads whatever's in dist/
```

Only worth doing for prod — dev is intentionally not meant to be crawled or
indexed at all (Basic-Auth-walled, `noindex` headers), so there's nothing to
prerender for.

### How requests find the prerendered files

`web-stack.ts`'s `SpaFallbackFunction` (a CloudFront Function on the
default/S3 behavior only) appends `/index.html` to the _current_ request
path for any extensionless URL, rather than always rewriting to a single
generic `/index.html`. So `/things/<id>/<slug>` resolves to
`things/<id>/<slug>/index.html` in S3 — the real prerendered file, if one
exists there.

### Per-page title/description

`apps/web/src/lib/useDocumentMeta.ts` — a small hook, no react-helmet
dependency needed for this few pages. Sets `document.title` and upserts a
`<meta name="description">` tag imperatively. Runs the same way whether the
page is rendered live in a browser or captured during the prerender crawl,
which is what makes each saved page's HTML have real per-page metadata
instead of the static shell's generic one. `ThingDetailPage.tsx` is the only
consumer so far — HomePage/SubmitPage/ModerationPage keep the shell's
generic title, which is accurate enough for those.

### Known limitations (accepted tradeoffs, not solved with runtime infra)

- **A thing added after the last prerender run has no prerendered file
  until the next one.** CloudFront Functions can't do conditional
  origin-response branching (no network calls, no "try X, fall back to Y"),
  so there's no way to detect "this route just doesn't have a prerendered
  file yet" and fall back to the generic shell at request time without
  Lambda@Edge — a bigger lift than this is worth right now. In the meantime
  that thing's page 403s until the next prerender+deploy. Re-running
  prerendering after any deploy that could have added things (a
  contribution approval) closes this gap; there's no automation for that
  yet.
- **A genuinely unknown/mistyped path also 403s**, for the same reason —
  there's no App.tsx route for it either, so this isn't strictly a
  regression from prerendering, but the failure mode changed from "blank
  page inside the site's normal chrome" to "a raw S3 XML error." Worth
  fixing with a real 404 page + Lambda@Edge origin-response fallback if it
  turns out to matter in practice.
- The bare `/things/<id>` URL (no slug) still works — the prerender script
  writes a duplicate copy of each thing's rendered HTML there too, since
  `ThingDetailPage`'s `:slug?` route param already treated it as valid (see
  [contributing.md](./contributing.md) for the semantic-URL design).
