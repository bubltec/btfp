# dist/lambda.js is already a fully self-contained esbuild bundle (see
# scripts/build-lambda.mjs) — no node_modules/install step needed, just wrap
# the one built file. Must run `pnpm --filter @btfp/bff build` before this
# image builds, same ordering requirement as the zip-based deploy it replaces.
#
# Pinned to 24, not the repo's dev-tooling 26 (see root package.json
# engines / .nvmrc): this is the actual Lambda execution runtime, and AWS
# only publishes this base image for versions Lambda supports — 24 is the
# newest as of writing (26 isn't LTS until next month, and Lambda hasn't
# added it yet). Bump this once AWS ships a `nodejs:26` tag.
FROM public.ecr.aws/lambda/nodejs:24

COPY dist/lambda.js ${LAMBDA_TASK_ROOT}/

CMD ["lambda.handler"]
