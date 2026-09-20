# Working in this repo

Agent instructions live in [`.cursor/rules/`](.cursor/rules/), the single source of
truth (see [AGENTS.md](AGENTS.md) for the index). Do not add rules to this file.

The always-apply rules are imported here so Claude Code loads them every session:

@.cursor/rules/sync-before-code-changes.mdc
@.cursor/rules/recover-from-merged-branch.mdc

Read `.cursor/rules/bff-typescript-cdk-best-practices.mdc` before changing the BFF,
shared packages, infrastructure, tests or CI.

Before adding an endpoint, an infra resource or a thing type, read the matching playbook:
`.cursor/rules/adding-an-api-endpoint.mdc`, `adding-an-infra-resource.mdc` or
`adding-a-thing-type.mdc`.
