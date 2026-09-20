# Agent instructions

**The source of truth for agent instructions in this repo is [`.cursor/rules/`](.cursor/rules/).**
Read the rules there before making changes. Rules with `alwaysApply: true` always
apply; the others apply when their `globs` match the files you are touching, or when
their `description` fits the task.

This file, `CLAUDE.md` and `.claude/skills/*` are pointers only. Do not add rules to any of
them. Add or change rules in `.cursor/rules/`, so there is exactly one place to keep current.

| Rule | Applies | Covers |
| --- | --- | --- |
| [`sync-before-code-changes`](.cursor/rules/sync-before-code-changes.mdc) | always | Fetch origin, compare `main` and the current branch, check whether the branch's PR merged, and the merge/rebase guard |
| [`recover-from-merged-branch`](.cursor/rules/recover-from-merged-branch.mdc) | on request | The stash-and-restart sequence when a branch's PR already merged |
| [`bff-typescript-cdk-best-practices`](.cursor/rules/bff-typescript-cdk-best-practices.mdc) | globs | Repo layout, NestJS BFF on Lambda, validation, config and secrets, AWS CDK conventions, testing, CI/CD |
| [`adding-an-api-endpoint`](.cursor/rules/adding-an-api-endpoint.mdc) | on request | Adding a BFF endpoint: module placement, the search cache, DynamoDB writes, guards, strict DTO validation |
| [`adding-an-infra-resource`](.cursor/rules/adding-an-infra-resource.mdc) | on request | Adding an AWS resource: which stack, credential-free synth, per-environment config, the cost budget |
| [`adding-a-thing-type`](.cursor/rules/adding-a-thing-type.mdc) | on request | Adding a thing type: the API call, quiz distractors, the seed pipeline, the submission form |

Also in this repo:

- [`.claude/skills/`](.claude/skills/) holds one-file pointers so Claude Code lists the three
  `adding-*` playbooks as skills. Each points at its `.cursor/rules/adding-*.mdc`.
  `.claude/launch.json` is configuration for the browser-preview tool, not instructions, and has to
  stay at that path.
- [`docs/`](docs/) holds human-facing architecture, data model, CI/CD and infra notes.
- The sibling library repo `../mycota` publishes the `@bubltec/mycota-*` packages this app
  consumes, and has its own `.cursor/rules/`.
