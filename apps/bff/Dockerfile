# dist/lambda.js is already a fully self-contained esbuild bundle (see
# scripts/build-lambda.mjs) — no node_modules/install step needed, just wrap
# the one built file. Must run `pnpm --filter @btfp/bff build` before this
# image builds, same ordering requirement as the zip-based deploy it replaces.
#
# Node 26 is a Lambda public-preview runtime until GA (targeted ~Nov 2026).
# The identifier stays `nodejs26.x` at GA; the image tag drops `-preview`.
# aws-cdk-lib has no NODEJS_26_X enum yet — this image *is* the runtime
# for DockerImageFunction, so the Dockerfile is the source of truth.
FROM public.ecr.aws/lambda/nodejs:26-preview

COPY dist/lambda.js ${LAMBDA_TASK_ROOT}/

CMD ["lambda.handler"]
