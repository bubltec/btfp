# dist/index.js is a self-contained esbuild bundle (see scripts/build.mjs) —
# run `pnpm --filter @btfp/scraper build` before this image builds. Plain
# long-lived-process shape, not Lambda-runtime-shaped like apps/bff/Dockerfile
# — this runs as a scheduled ECS Fargate task, not behind the Lambda runtime
# interface. playwright-core is installed at image build time because the
# bundle marks it external (CDP client only — no local Chrome).
FROM node:26-slim

WORKDIR /app
COPY dist/index.js /app/index.js
COPY package.runtime.json /app/package.json
RUN npm install --omit=dev

CMD ["node", "/app/index.js"]
