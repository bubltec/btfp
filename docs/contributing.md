# Contributing (code)

```bash
git clone git@github.com:bubltec/btfp.git
pnpm install
docker compose up -d          # DynamoDB Local
pnpm seed:local                 # load seed data
pnpm dev                        # bff on :3001, web on :5173 (proxies /api to bff)
```

Framework code (auth, DynamoDB client, SSM config, CDK constructs) lives in a separate project,
[mycota](https://github.com/bubltec/mycota), consumed as an ordinary published npm dependency
(`@bubltec/mycota-*`) — see [Working on mycota](#working-on-mycota-a-separate-published-package)
below for how to pull in framework changes.

Copy `apps/bff/.env.example` to `apps/bff/.env` for OAuth/JWT config; the app boots fine
without it, but sign-in won't work until GitHub OAuth credentials are set (see
[verification-flow.md](verification-flow.md)). If you have AWS access, `pnpm secrets:sync dev`
fills in the real `JWT_SECRET`/`GITHUB_CLIENT_SECRET` values instead of leaving placeholders
(see [Secrets](./infra.md#secrets)).

Recommended: install [direnv](https://direnv.net) (`brew install direnv`, then add
`eval "$(direnv hook zsh)"` — or the equivalent for your shell — to your shell rc file) and run
`direnv allow` once in `apps/bff` and `infra/cdk`. Both already have an `.envrc` checked in, so
`cd`-ing into either then just loads its `.env`/`.env.deploy.local` automatically — no more
remembering to `source` anything by hand.

## Git hooks (Lefthook)

**Oxlint** and **oxfmt** run **on commit**, not in CI — full-tree lint/format in GitHub Actions
duplicated what hooks already enforce on every commit.

After `pnpm install`, the root `prepare` script runs `lefthook install` and registers a
**pre-commit** hook (`lefthook.yml` at the repo root). On each commit it:

- runs **oxlint** with `--fix` on staged `*.{js,jsx,ts,tsx,mjs,cjs}` files (`.oxlintrc.json`)
- runs **oxfmt** with `--write` on those same files (`.oxfmtrc.json`)
- re-stages any fixes (`stage_fixed: true`)

Only staged files in the commit are touched, so hooks stay fast. **mycota** uses the same hook
shape and the same oxlint/oxfmt settings in its own repo — that's entirely mycota's own concern
now, nothing to configure from btfp's side.

If hooks are missing (new clone, skipped `pnpm install`), run `pnpm exec lefthook install` from
that repo’s root. To bypass once: `git commit --no-verify` (use sparingly — CI still runs
typecheck/build on the whole tree).

Manual full-tree checks when you need them: `pnpm run lint`, `pnpm run format` (each repo root —
not turbo tasks). Day-to-day lint/format happen in **Lefthook** on commit.

## Working on mycota (a separate, published package)

[mycota](https://github.com/bubltec/mycota) is its **own project** — NestJS/Dynamo/auth/config/CDK
packages, its own git history and CI. It's published to the public npm registry as
`@bubltec/mycota-*`, and btfp consumes it as an ordinary dependency — no submodule, no workspace
linking.

Every relevant push to mycota's `main` publishes one of two ways:

- **No `#major`/`#minor`/`#patch` marker in the merge commit** (the normal case) — publishes a
  rolling prerelease under the `next` dist-tag (e.g. `1.2.1-next.42`).
- **Marker present** (put it in the PR title — that's what becomes the squash-merge commit
  subject) — cuts a real semver release, publishes under `latest`, and tags/releases it in git.

### Typical loop

1. **Edit framework code** in a separate clone of [bubltec/mycota](https://github.com/bubltec/mycota)
   (`git clone git@github.com:bubltec/mycota.git` somewhere outside this repo).
2. **Open a PR, merge to `main`** — its CI runs `pnpm turbo run typecheck build test`, then
   publishes automatically per the rule above. Include a `#major`/`#minor`/`#patch` marker in the
   PR title if this should be a real release rather than just moving `next` forward.
3. **Pull the new version into btfp**:

   ```bash
   pnpm mycota:pull
   ```

   This bumps `@bubltec/mycota-auth`/`-dynamo`/`-professional-verification` in `apps/bff`,
   `@bubltec/mycota-config`/`-dynamo` in `apps/scraper`, and `@bubltec/mycota-cdk` in
   `infra/cdk` to whatever `latest` (the most recent real release) currently resolves to.
   This is a **deliberate, one-time pull** — package versions are pinned at install time,
   not auto-updating, so re-run this whenever you want the newest release. To track the
   rolling prerelease instead, run `pnpm add @bubltec/mycota-x@next` for the specific
   packages you need.
4. **Validate**: `pnpm turbo run typecheck build test`.
5. **Commit the result** like any other dependency bump — it's just a `package.json`/
   `pnpm-lock.yaml` diff, no special submodule-pointer ceremony.

For a fast local edit-and-test loop against a mycota change without waiting for a publish:
`pnpm link --global` from your mycota clone, then `pnpm link --global @bubltec/mycota-auth` (etc.)
in this repo.

### What not to do

- Don't add btfp-only concepts (`@btfp/shared-types`, app routes, etc.) into mycota; keep shared
  **domain** types in btfp's `packages/shared-types` and **framework** types in `@bubltec/mycota-auth`.

## Before opening a PR

```bash
pnpm turbo run typecheck build test   # same as CI (includes BFF contribution tests)
```

Lint and format should already be correct from the Lefthook pre-commit hook. For a full-tree
pass manually: `pnpm run lint` and/or `pnpm run format`.

Linting is [oxlint](https://oxc.rs), formatting is [oxfmt](https://oxc.rs) — both Rust-based
replacements for ESLint/Prettier, configured at `.oxlintrc.json`/`.oxfmtrc.json` in each repo
root and applied on commit via Lefthook (see above). `oxfmt` is still alpha software; if it ever
produces something clearly wrong, that's worth a GitHub issue upstream rather than working
around it silently here.

For end-to-end coverage of a real user flow, see [e2e-testing.md](e2e-testing.md) — generate
a Playwright test from a plain-English description rather than writing one by hand.

## Conventions

- TypeScript everywhere, `workspace:*` for internal package references.
- Shared types (`Thing`, `PetType`, etc.) live in `packages/shared-types` — add there first
  if a change touches both `apps/bff` and `apps/web`.
- No inline comments beyond a line or two, and only where the *why* isn't obvious from the
  code. See `.claude/skills/` for guided patterns when adding a new thing type, API
  endpoint, or infra resource.
