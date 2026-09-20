# Agent instructions

**The source of truth for agent instructions in this repo is [`.cursor/rules/`](.cursor/rules/).**
Read the rules there before making changes. Rules with `alwaysApply: true` always
apply; the others apply when their `globs` match the files you are touching, or when
their `description` fits the task.

This file and `CLAUDE.md` are pointers only. Do not add rules here. Add or change
them in `.cursor/rules/`, so there is exactly one place to keep current.

| Rule | Applies | Covers |
| --- | --- | --- |
| [`sync-before-code-changes`](.cursor/rules/sync-before-code-changes.mdc) | always | Fetch origin, compare `main` and the current branch, check whether the branch's PR merged, and the merge/rebase guard |
| [`recover-from-merged-branch`](.cursor/rules/recover-from-merged-branch.mdc) | on request | The stash-and-restart sequence when a branch's PR already merged |
| [`bff-typescript-cdk-best-practices`](.cursor/rules/bff-typescript-cdk-best-practices.mdc) | globs | Repo layout, NestJS BFF on Lambda, validation, config and secrets, AWS CDK conventions, testing, CI/CD |

Also in this repo:

- [`.claude/skills/`](.claude/skills/) holds Claude Code task playbooks (adding an API
  endpoint, an infra resource, or a thing type). They follow the conventions in the rules above.
- [`docs/`](docs/) holds human-facing architecture, data model, CI/CD and infra notes.
- The sibling library repo `../mycota` publishes the `@bubltec/mycota-*` packages this app
  consumes, and has its own `.cursor/rules/`.
