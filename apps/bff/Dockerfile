# dist/lambda.js is already a fully self-contained esbuild bundle (see
# scripts/build-lambda.mjs) — no node_modules/install step needed, just wrap
# the one built file. Must run `pnpm --filter @btfp/bff build` before this
# image builds, same ordering requirement as the zip-based deploy it replaces.
#
# Node 26 everywhere (local .nvmrc, CI, this image). Tag is `26-preview`
# until AWS GA (~Nov 2026); it's still Node 26.
FROM public.ecr.aws/lambda/nodejs:26-preview

# The .map is what lets NODE_OPTIONS=--enable-source-maps (set in api-stack.ts)
# turn minified stack traces back into real file:line.
COPY dist/lambda.js dist/lambda.js.map ${LAMBDA_TASK_ROOT}/

CMD ["lambda.handler"]
