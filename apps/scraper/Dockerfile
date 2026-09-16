# dist/index.js is a self-contained esbuild bundle (see scripts/build.mjs) —
# run `pnpm --filter @btfp/scraper build` before this image builds. Plain
# long-lived-process shape, not Lambda-runtime-shaped like apps/bff/Dockerfile
# — this runs as a scheduled ECS Fargate task, not behind the Lambda runtime
# interface.
FROM node:26-slim

COPY dist/index.js /app/index.js

CMD ["node", "/app/index.js"]
