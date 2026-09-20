# Working in this repo

## Check for upstream changes before starting work

Before making any changes, run `git fetch origin` and compare local `main`
against `origin/main` (`git log main..origin/main --oneline`). Work
sometimes gets committed, pushed, and merged to `main` outside the current
session — a previous session, a teammate, a direct push — so local state
can be stale in ways that aren't obvious from `git status` alone.

Also check the **current branch** before editing: `git log HEAD..origin/main
--oneline` and whether its PR is already merged (`gh pr list --head
<branch> --state all`). If the PR merged, stop committing on that branch —
rebase or branch fresh from `origin/main` for follow-ups (see step 2 below).
If the PR is **not** merged and the branch already has commits not in
`origin/main`, keep working on that branch (rebase if behind); do not start
a second branch for the same work.

If `origin/main` has commits not in local `main`:

1. Check whether the **current branch's own work** already shipped —
   `gh pr list --state merged --head <current-branch> --json number,mergedAt,mergeCommit`.
   If a merged PR shows up for this exact branch, its content is already in
   `main` under a (possibly squashed) different commit.
2. If so: `git stash -u` (uncommitted work, including untracked files),
   `git checkout main`, `git fetch . origin/main:main` to fast-forward,
   `git checkout -b <new-branch-name>` for whatever comes next, then
   `git stash apply` (not `pop` — keep the stash entry until you've
   confirmed the reapplied changes are actually still needed/correct, since
   some of what was stashed may now be redundant with what already merged).
3. If `origin/main` moved but the *current* branch's PR was **not** merged
   (i.e., it's genuinely unrelated upstream work), just surface that to the
   user — don't act on it unilaterally.

Only do the stash-and-restart sequence when there's no merge/rebase already
in progress (`git rev-parse --verify MERGE_HEAD` / `.git/rebase-merge` both
absent) — if one exists, that means work to reconcile this exact situation
is already underway; ask the user how they want to proceed instead of
stashing over it.
