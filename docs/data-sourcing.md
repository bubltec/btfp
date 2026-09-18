# Data sourcing

## Current seed

`data/seed/source/dog-toxicity-dataset.json` — ASPCA-derived toxic/non-toxic plant lists
plus a compiled foods/medications list (see its own `metadata` block for exact sources and
scrape date). Transformed by `data/seed/src/transform.ts` into `plant`, `food`, and
`medication` Things, each tagged with the pet types they're dangerous to (`dog`, plus
`cat`/`horse` where the source noted it).

**This file is gitignored, not committed.** It's scraped ASPCA content, and this repo is
public — redistributing it under this repo's license isn't something to do without
ASPCA's sign-off. Keep your own local copy at that path to run `pnpm seed:local`; ask
whoever gave you the original dataset for a copy if you don't have one.

## vetmeds.org (American College of Veterinary Pharmacists)

`data/seed/src/scrape-vetmeds.ts` pulls ~106 professionally-authored toxin
entries from vetmeds.org's Pet Poison Control (via its public WordPress
REST API — structured JSON, no HTML scraping needed) into
`data/seed/source/vetmeds-staging.json`. It extracts only short,
structured facts (clinical signs, toxic-dose summary, category) — never
the source's full descriptive prose verbatim.

This is **not** a "broad automated scraping" exception to the philosophy
above — it's an implementation of it. The script only does the tedious
fetch-and-parse labor; nothing is promoted to seed data or seeded as a
`verified: true` `Thing` until a human has actually reviewed and corrected
the staging output (category/`thingTypeId`/severity assignment is
deliberately left to that review step, not inferred by the script) and
copied it to `data/seed/source/vetmeds-toxins.json`. Both files are
**gitignored, not committed** — same reasoning as the ASPCA dataset above:
this is vetmeds.org's copyrighted clinical content, and redistributing it
under this repo's license isn't something to do without their sign-off.

`data/seed/src/run.ts` loads `vetmeds-toxins.json` optionally — a
contributor without that (gitignored) file can still run `seed:local`
using just the datasets above.

## Dog breed roster + physical traits

`data/seed/source/dog-breeds.json` — 195 AKC-recognized dog breeds, each tagged with zero or
more physical traits (`long-backed`, `brachycephalic`, `giant-breed`, `toy-breed`,
`deep-chested`) from the closed `BreedTrait` vocabulary in `packages/shared-types/src/breed.ts`.
Seeded as `Breed` records (`transformDogBreeds` in `data/seed/src/transform.ts`), separate from
`Thing`. Lets a `Thing`'s `petTypes[].breedTraits` scope a risk to breeds sharing a trait (e.g.
stairs being risky specifically for `long-backed` breeds) instead of either the whole species or
a hand-maintained breed-name list.

Committed, not gitignored — unlike the sources above, this isn't a single publisher's
copyrighted content: the breed roster is AKC breed names via
[kkakey/dog_traits_AKC](https://github.com/kkakey/dog_traits_AKC) (reformatted into standard
breed-name form), and the trait tags are manually compiled from public veterinary sources, not
copied verbatim from any one page. Per-trait citations:

- **long-backed** (chondrodystrophic/IVDD risk): [Hill's Pet — Chondrodystrophic Dog Breeds](https://www.hillspet.com/dog-care/healthcare/chondrodystrophic-short-legged-dog-breeds), [AKC — Intervertebral Disk Disease in Dogs](https://www.akc.org/expert-advice/health/intervertebral-disk-disease-dogs/)
- **brachycephalic**: [ACVS — Brachycephalic Syndrome](https://www.acvs.org/small-animal/brachycephalic-syndrome/) (AKC's 16-breed list)
- **giant-breed**: [Great Pet Care — Dog Breeds Prone to Bloat (GDV)](https://www.greatpetcare.com/dog-breeds/dog-breeds-prone-to-bloat-gdv/)
- **deep-chested** (bloat/GDV risk): same Great Pet Care source as above
- **toy-breed**: [AKC — Dog Breeds Sorted by Group](https://www.akc.org/public-education/resources/general-tips-information/dog-breeds-sorted-groups/) (Toy Group)

Not every breed has a tagged trait — an empty `traits` array just means none of the five
curated categories apply, not that the breed was skipped. Dog-only for now; cat breed traits
(e.g. brachycephalic Persian/Himalayan) would be a natural follow-up but aren't in scope yet.

## Seeding prod in CI

`deploy-prod` runs `data/seed/src/run.ts` against `btfp-prod-content` after `cdk deploy` (see
[ci-cd.md](./ci-cd.md)), so merging a change to a *committed* seed source (`dog-breeds.json`,
`product-activity-hazards.json`) reaches prod automatically — no separate manual seed step, same
"merge is the deploy trigger" model the rest of the pipeline already uses.

This deliberately does **not** cover `dog-toxicity-dataset.json` or `vetmeds-toxins.json` — both
gitignored per the licensing notes above, so CI has no copy to load; `run.ts` skips whichever of
those it can't find on disk (same optional-load pattern for both) and only reseeds what's
actually there. Updating the ASPCA/vetmeds content in prod is still a manual step, run locally
against `btfp-prod-content` (e.g. `CONTENT_TABLE_NAME=btfp-prod-content pnpm --filter @btfp/seed
exec tsx src/run.ts`, with real AWS credentials and no `--endpoint` flag) from a machine that has
those files.

Two things worth knowing about what this automation trades off:

- **Blind overwrite, not a diff.** Every run rewrites every curated row by its stable hashed id —
  fine for the reference data itself, but it will silently revert any hand-edit made directly to
  a seeded `Thing` outside the normal moderation/contribution flow. Overlapping source rows
  (the same plant listed under every common name, ASPCA vs vetmeds spelling variants) are
  collapsed before write; ids that existed only as the discarded duplicate are deleted so a
  re-seed doesn't leave both the canonical row and the old extra in the table.
- **Renamed/split source items are reconciled too, not just same-run duplicates.** The
  `discarded` list from `dedupeThings` only covers rows collapsed *within the current run* — it
  says nothing about a row that existed from a *previous* run but whose source item was renamed,
  split, or removed since then (exactly what happened when the "Onions, garlic, leeks, chives,
  shallots (Allium spp.)" combo entry was split into per-species rows: the old combo name simply
  stops appearing in `uniqueThings`, so it's never in `discarded` either). Left alone, that old
  row sits in the table forever next to its replacement. `run.ts` additionally scans the table for
  existing `THING#…` rows with no `contributorId` (i.e. still exactly what a prior seed run wrote,
  never touched by the contributions/approve flow) whose id isn't in this run's output, and deletes
  those too. Rows that went through moderation — a brand-new contributor submission, or an
  approved edit merged into an existing seed row — always have `contributorId` set and are never
  touched by this cleanup, even if their id happens to match a stable id this run no longer emits.
- **Scoped IAM grant.** `infra/cdk/lib/ci-stack.ts`'s GitHub Actions deploy role is otherwise kept
  to `sts:AssumeRole` on CDK's own bootstrap roles only (see that file's comments) — seeding is
  the one exception, a narrow `dynamodb:BatchWriteItem` grant on exactly the prod content table.

## Bedrock-assisted similarity review

Deterministic dedupe (`dedupeThings` in `packages/shared-types/src/dedupe.ts`) is good at
collapsing exact/near-exact name matches from overlapping sources, but it can't tell that a
single row is secretly a *list*. The ASPCA dataset's `"Onions, garlic, leeks, chives, shallots
(Allium spp.)"` food entry is the motivating example: five distinct species lumped into one
row hid that garlic is 3–5x more toxic per gram than the others, and matching against vetmeds'
separate `"Onions, Garlic and Chives"` entry just merged two combo rows into one bigger combo
row instead of surfacing that per-species (per-source) split.

A full sweep of the current local seed sources for this pattern turned up over a dozen more
combo rows (`"Grapes / raisins / currants / sultanas"`, `"Raw/undercooked meat, eggs, bones"`,
`"Vitamin D3 (cholecalciferol) supplements & some rodenticides"`, `"Beta-blockers & calcium
channel blockers"`, `"String, yarn, ribbon, dental floss, tinsel (linear foreign bodies)"`,
`"Pseudoephedrine & Phenylephrine"`, `"Ibuprofen & Naproxen"`, `"Cannabis / THC edibles"`,
`"Moldy food / compost"`, `"Salt / homemade play dough / paintballs"`) — each split into its
individual named items, now that `dedupeThings`' merge no longer drops a source's data on an
id collision (see the fix in `packages/shared-types/src/dedupe.ts`, below). Not every
`&`/`/`/`,`-containing name is a real combo, though — `"Chocolate / cocoa"`, `"Ibuprofen
(Advil, Motrin)"`, `"Glue / adhesives"`, `"Nicotine (cigarettes, vape liquid, patches, gum)"`
are one substance/item under multiple names or brand listings, not a bundle of distinct
things, and are deliberately left as a single row. The judgment call each time: would a pet
owner search for these terms *separately*, and does lumping them together hide a real
difference (potency, severity, product category) between them? If yes to either, split; if
the "combo" is really just synonyms or brand names for one thing, leave it — that's also why
this is a curation aid a human reviews (or Bedrock analyzes) rather than an automatic rule; a
plain word-list heuristic can't reliably tell "Onions, garlic, leeks..." apart from "Grapes /
raisins" (both real splits) from "Chocolate / cocoa" or "Ibuprofen (Advil, Motrin)" (not).

One more failure mode worth knowing: splitting a combo entry from source A only reunites with
the matching row from source B if the two rows agree on `thingTypeId`. `"Nicotine & Tobacco"`
from vetmeds came in tagged `thingTypeId: 'drug'` (vetmeds categorizes it under "Illicit &
Recreational Drugs"), while ASPCA's existing `"Nicotine (cigarettes, vape liquid, patches,
gum)"` sits under `'medication'` (this dataset's raw `medications` array hardcodes that
type) — splitting the vetmeds row without reconciling the type would have produced two
same-substance rows sitting side by side, unmerged, which is exactly the bug this whole
exercise is trying to catch. Check for this whenever a split's name would otherwise
token-match an existing row.

`pnpm --filter @btfp/seed review:similar` (`data/seed/src/review-similar-run.ts`) scans the
local seed source files for combo-looking names (comma lists, "X and Y", "X & Y" — see
`looksLikeComboName` in `data/seed/src/review-similar.ts`) and asks Bedrock, per candidate,
whether it actually bundles multiple distinct items and which existing catalog rows overlap
with it. It prints a report; **it does not rewrite anything**, same human-review requirement as
the rest of this doc — a maintainer reads the suggestions and edits the source JSON by hand
(split the combo row into individual entries, each carrying its own severity/details, letting
`dedupeThings` do its normal job of merging same-named rows across sources once they're
atomic). Requires Bedrock access from your local AWS credentials, same as `apps/e2e/scripts/
generate.ts`'s local Bedrock use — no additional IAM setup needed for a personal AWS profile
with `bedrock:InvokeModel`.

This is a curation aid to run periodically (e.g. after adding a new source or before a big
reseed), not a step in `seed:local`/`run.ts` — running Bedrock against every seed on every
local seed would be slow, costly, and, per the human-review philosophy above, a Bedrock
"split this" call is a strong-enough claim about clinical content that it belongs in front of
a person, not wired into the write path (contribution write path also intentionally keeps
`findDuplicateThing`'s deterministic matching, not Bedrock, for the same reason — a hallucinated
auto-link on `POST /contributions` linking or un-linking a submission would be worse than the
duplicate this is meant to catch).

## Expanding coverage

Deliberately **not** proposing broad automated scraping here — most veterinary/poison-control
sites have terms of service around reuse, and scraped data needs a human to sanity-check
before it reaches a "this might hurt your pet" database. Candidate sources to manually
review and curate from, same pattern as the current dataset (attribute the source, keep the
disclaimer, respect robots.txt/ToS):

- Pet Poison Helpline's toxin list (foods, plants, household chemicals)
- ASPCA's cat-specific toxic plant list (current dataset is dog-focused)
- CPSC recall database, filtered for pet toys/products
- FDA pet food and pet medication recalls
- Manufacturer safety notices for collars/harnesses/leashes (less standardized — likely
  needs case-by-case sourcing rather than a single feed)

## Community contributions feed the same pipeline

Once approved (see [verification-flow.md](verification-flow.md)), a contribution becomes a
regular `Thing` with `source` set to `contributor:<id>` instead of a citation — same shape,
same table, same search index. No separate "user-generated" tier.
