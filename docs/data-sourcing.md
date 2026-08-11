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
  a seeded `Thing` outside the normal moderation/contribution flow.
- **Scoped IAM grant.** `infra/cdk/lib/ci-stack.ts`'s GitHub Actions deploy role is otherwise kept
  to `sts:AssumeRole` on CDK's own bootstrap roles only (see that file's comments) — seeding is
  the one exception, a narrow `dynamodb:BatchWriteItem` grant on exactly the prod content table.

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
