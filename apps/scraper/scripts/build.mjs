import { build } from 'esbuild';

// No decorator metadata to worry about here (no NestJS, no DI) — a plain
// esbuild TS transform is fine, unlike apps/bff's two-step tsc+esbuild build.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node26',
  // CJS avoids needing "type": "module" in the deployed image — Node treats
  // a bare .js file as CJS by default.
  format: 'cjs',
  sourcemap: true,
  minify: true,
  logLevel: 'info',
});
