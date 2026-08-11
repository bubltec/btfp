# CI/CD

GitHub Actions builds once, deploys to dev, runs e2e against the live dev deployment, then —
only after a human approves — promotes the exact same build to prod. No more manual
`cdk deploy` for routine changes (that path still works, see [docs/infra.md](./infra.md), and
is the fallback for hotfixes or debugging a broken pipeline).

## The path a change takes

1. **Branch, PR into `main`.** `.github/workflows/ci.yml` runs typecheck/build on the PR.
   Lint and format are enforced locally via [Lefthook](contributing.md#git-hooks-lefthook) on
   commit, not re-checked in CI. No AWS credentials exist anywhere in this workflow — PRs can't
   deploy anything, by construction (see [OIDC setup](#github-oidc-setup-for-aws) below).
2. **Merge.** `main` requires the `CI / check` status to pass first (branch protection, set up
   once — see [Manual one-time setup](#manual-one-time-setup)). Merging triggers
   `.github/workflows/deploy.yml`.
3. **`build`** — installs, builds every package (`turbo run typecheck build`), uploads
   `apps/bff/dist` and `apps/web/dist` as GitHub Actions artifacts. Every later job downloads
   these instead of rebuilding — this is what makes "the same thing promoted to prod" literally
   true, not just "the same source re-built twice."
4. **`deploy-dev`** — assumes the deploy role via OIDC, runs `cdk deploy BtfpDev/*`. The BFF
   Lambda is a container image (`apps/bff/Dockerfile`, `DockerImageCode.fromImageAsset` in
   `infra/cdk/lib/api-stack.ts`) — the Docker build and push to ECR happen automatically inside
   this one `cdk deploy` call. Dev is never prerendered (Basic-Auth-walled, `noindex` — see
   [docs/seo.md](./seo.md)), so that's the whole job.
5. **`e2e`** — runs `apps/e2e`'s Playwright suite against `https://dev.badthingsforpets.com`,
   the exact invocation [docs/e2e-testing.md](./e2e-testing.md) already documented running by
   hand. A failure here stops the pipeline; prod is untouched.
6. **`prod-diff`** — computes `cdk diff BtfpProd/*` and posts it to the job's summary. Runs
   automatically (not gated), specifically so the diff is visible *before* anyone is asked to
   approve the next job — a diff computed inside the gated job itself would only appear after
   the deploy already happened, which defeats the point.
7. **`deploy-prod`** — gated by GitHub's `production` Environment protection rule: this job
   does not start until a required reviewer clicks approve in the Actions UI. Once approved:
   downloads the *same* build artifacts from step 3 (not rebuilt), `cdk deploy BtfpProd/*`, then
   reseeds the two committed content datasets (`data/seed/source/dog-breeds.json`,
   `product-activity-hazards.json`) straight into `btfp-prod-content` — see
   [data-sourcing.md](./data-sourcing.md#seeding-prod-in-ci) for what this does and doesn't
   cover — then crawls the now-live prod API with `apps/web/scripts/prerender.mjs` and runs
   `cdk deploy BtfpProd/Web` a second time to sync the real per-route HTML — mirrors the manual
   two-pass deploy already documented in `docs/infra.md`, just automated.

## Branch naming

Prefix every branch with what kind of change it is:

- `feat/` — new functionality
- `fix/` — bug fix
- `spike/` — throwaway exploration/prototype, not meant to ship as-is
- `debt/` — refactor/cleanup/tech-debt paydown, no user-facing behavior change

e.g. `feat/professional-verification`, `fix/logout-redirect-302`,
`spike/agentcore-browser-eval`, `debt/oidc-trust-policy-cleanup`. Documentation-only for now —
not enforced by `ci.yml` — easy to tighten into a required check later if naming drifts.

## How to ship a change

1. Branch off `main` (named per [Branch naming](#branch-naming) above), make the change, push,
   open a PR. `ci.yml` runs automatically.
2. Once `CI / check` is green, merge. This is the only required step before `main` deploys
   itself — merging **is** the deploy trigger, there's no separate "now deploy" action.
3. Watch it run: `gh run watch --repo bubltec/btfp` (or the
   [Actions tab](https://github.com/bubltec/btfp/actions)) picks up the newest run
   automatically. `build` → `deploy-dev` → `e2e` take a few minutes combined.
4. If `e2e` fails, prod is never touched — fix forward with a new PR (same as step 1; direct
   pushes to `main` aren't possible for anyone, admins included — see below) and let the
   pipeline re-run from the top once it merges. Don't re-run the failed job in isolation — a
   later job re-run without the earlier ones means it's no longer testing what will actually
   ship.
5. Once `e2e` and `prod-diff` are green, `deploy-prod` shows **Waiting** in the Actions UI — this
   is the approval gate, not a hang or a failure. Open the run, click into `deploy-prod`, hit
   **Review deployments**, read `prod-diff`'s summary (a real `cdk diff BtfpProd/*`, computed
   *before* the gate so it's not blind), then **Approve and deploy**.
6. `deploy-prod` finishes: same artifacts promoted, then prerender-against-live-prod-API, then
   one more `cdk deploy BtfpProd/Web` to sync the real per-route HTML. Spot-check the live site
   once it's done.

For a hotfix that can't wait on CI, or to debug a broken pipeline, the manual `cdk deploy` path
in [docs/infra.md](./infra.md) still works unchanged — this pipeline doesn't replace it, it
automates the routine case.

## Adding or changing who can approve production deploys

The required-reviewer list on the `production` GitHub Environment is the only thing standing
between `deploy-prod` and actually running — there's no equivalent gate in IAM (see
[OIDC setup](#github-oidc-setup-for-aws) above). To add someone:

- **UI**: repo Settings → Environments → `production` → under "Deployment protection rules",
  edit "Required reviewers" → add the person (they need at least read access to the repo) →
  Save protection rules.
- **CLI**, if you'd rather script it — needs the person's numeric GitHub user ID, not their
  login:
  ```bash
  NEW_REVIEWER_ID=$(gh api users/<their-username> --jq .id)
  # Merge with whatever reviewers are already configured — this PUT replaces the whole list,
  # it doesn't append.
  gh api repos/bubltec/btfp/environments/production -X PUT --input - <<EOF
  {
    "reviewers": [
      {"type": "User", "id": <existing-reviewer-id>},
      {"type": "User", "id": $NEW_REVIEWER_ID}
    ],
    "deployment_branch_policy": {"protected_branches": true, "custom_branch_policies": false}
  }
  EOF
  ```
  A team works too: `{"type": "Team", "id": <team-id>}`, from `gh api orgs/bubltec/teams/<slug>
  --jq .id` — usually the better call once this is more than a couple of people, since it
  doesn't need a re-PUT every time membership changes.
- To remove someone, PUT the same way with them left out of the `reviewers` array.
- To check who's currently a reviewer without changing anything:
  `gh api repos/bubltec/btfp/environments/production --jq '.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login'`.

## Why promotion is a real guarantee, not just "the same source"

CDK's Docker image assets (`DockerImageCode.fromImageAsset`) are content-hash-addressed: the
hash is computed from the Dockerfile and build context only (not account, region, or stack
name). `deploy-dev` and `deploy-prod` both build from the identical `apps/bff/dist` artifact
downloaded from the same `build` job, so they produce the identical hash — `deploy-prod`'s image
push is a genuine no-op (the tag already exists in the shared bootstrap ECR repo from the dev
push), not a rebuild. `platform: Platform.LINUX_AMD64` is pinned explicitly in `api-stack.ts` so
this holds even if someone later builds locally on Apple Silicon, which would otherwise hash
differently than GitHub's runners and silently produce an undeduplicated second image.

The web bundle is promoted the same way: `web-dist` is downloaded verbatim in `deploy-prod`, not
rebuilt from source — only the prerendered HTML layered on top of it is regenerated per
environment (it has to be; it's a crawl of that environment's own live, and legitimately
different, data).

## GitHub OIDC setup for AWS

No long-lived AWS credentials are stored in GitHub at all. Instead:

- **`infra/cdk/lib/ci-stack.ts`** imports the AWS account's existing
  `token.actions.githubusercontent.com` OIDC identity provider (it predates this project, from
  an unrelated AWS setup — IAM only allows one per URL per account, so this stack references it
  rather than creating a second one).
- It creates one IAM role, `btfp-gha-deploy`. Its trust policy allows that OIDC provider to
  assume it, but only when the token's `sub` claim matches one of two patterns:
  `repo:bubltec@310348769/btfp@1301972078:ref:refs/heads/main` (for `deploy-dev`/`prod-diff`,
  which run as a plain push to `main`) or
  `repo:bubltec@310348769/btfp@1301972078:environment:production` (for `deploy-prod`
  specifically — a job with `environment:` set gets an *environment-scoped* `sub`, not the
  ref-based one, regardless of what ref triggered it). Both were confirmed empirically, not
  assumed from docs: a temporary debug step printed the real token each time, first showing the
  `@<id>`-suffixed org/repo form (GitHub's immutable IDs — safer than plain names too, since it
  survives a rename and can't be hijacked by transferring the name to a different org), then
  showing deploy-prod's `sub` failing to assume-role against the ref-only pattern until the
  `environment:production` pattern was added alongside it. A PR-triggered run's token matches
  neither (`repo:bubltec@.../btfp@...:pull_request`), so `ci.yml` genuinely cannot assume this
  role even if it tried.
- The role's **only** permission is `sts:AssumeRole` on four existing CDK bootstrap roles
  (`deploy-role`, `file-publishing-role`, `image-publishing-role`, `lookup-role` — created once,
  already, by `cdk bootstrap`). It has no direct S3/Lambda/CloudFormation/ECR permissions of its
  own; every actual resource mutation happens through those already-scoped bootstrap roles. This
  is the standard minimal-surface way to wire GitHub Actions to an account that already uses CDK.
- **This is not as narrow as it sounds.** `cfn-exec-role` (one of the four, assumed internally
  by `deploy-role`) carries `AdministratorAccess` by default — that's CDK's own bootstrap
  default, not something this stack chose. So `btfp-gha-deploy`'s effective reach is full
  account admin, gated only by that `sub` condition. That's exactly why requiring the `ci.yml`
  check on `main` (branch protection, below) is load-bearing and not optional polish: it's the
  only thing standing between "anyone who can push to main" and "anyone who can deploy
  anything."
- Prod additionally requires a human clicking approve (the `production` Environment rule) — that
  gate lives in GitHub's own settings, not in IAM at all.

`infra/cdk/bin/app.ts` deploys `CiStack` once, standalone, the same way as `BtfpDns`/`BtfpEmail`.

## Manual one-time setup

Not automatable from CDK — these are GitHub repo settings.

1. **Secrets** (Settings → Secrets and variables → Actions → *Secrets*): `AWS_DEPLOY_ROLE_ARN`
   (`arn:aws:iam::<account>:role/btfp-gha-deploy`, from `CiStack`'s `DeployRoleArn` output),
   `BTFP_DEV_BASIC_AUTH_USER`, `BTFP_DEV_BASIC_AUTH_PASSWORD`, `BTFP_DEV_JWT_SECRET`,
   `BTFP_PROD_JWT_SECRET`, `BTFP_BRAVE_SEARCH_API_KEY` — same real values already in the
   gitignored `infra/cdk/.env.deploy.local`.
2. **Variables** (same page → *Variables*): `BTFP_HOSTED_ZONE_ID` — not secret, just not worth
   hardcoding.
3. **`production` Environment** (Settings → Environments → New environment, name it
   `production`): add yourself as a required reviewer. This is the actual prod approval gate.
4. **Branch protection on `main`** (Settings → Branches → Add rule): require the `CI / check`
   status check before merging, and **enable "Include administrators"** (`enforce_admins`) —
   without it, anyone with admin access can bypass the check and push straight to `main`,
   silently defeating the whole point of requiring it. With this on, there is no direct-push
   path for anyone; every change, including hotfixes, goes through a PR.
5. **(Pending)** Require an actual approving review before merge, not just the `check` status —
   passing CI was never meant to substitute for a human looking at the diff. Blocked on one
   thing: PRs need to be authored by an identity other than the reviewer's own, since GitHub
   never counts a PR author's own approval toward a required-review rule. Needs a dedicated
   bot/machine GitHub account (or GitHub App) used only for opening PRs, distinct from whoever's
   reviewing and merging them. Once that identity exists: Settings → Branches → edit the `main`
   rule → enable "Require a pull request before merging" → "Require approvals" (1).

## Known accepted risks

- **e2e pollutes dev's real data.** The generated spec does a real `POST /submit` and a real
  email sign-up against dev's actual DynamoDB tables on every run. Accepted rather than built
  around — dev isn't a pristine/indexed environment anyway. Wipe/reseed it periodically by hand
  if it gets noisy (`docs/infra.md` has the seed command).
- **A `prod-diff`/`deploy-prod` failure between the two `BtfpProd` deploys leaves prod running
  new API/DB code with stale web assets** until the job is re-run or the prerender+web-deploy
  steps are run manually (same commands `docs/infra.md` documents). This is visible (a red job
  in Actions), not silent. Automatic rollback for this narrow window is more infra than this
  project's size warrants.
