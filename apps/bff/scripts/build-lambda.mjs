import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

// tsc compiles first so decorator metadata (NestJS DI's design:paramtypes)
// comes from real type-checking. esbuild's own TS transform doesn't reliably
// reproduce this for bundled/minified output, and DI silently resolves
// constructor params as undefined if it's wrong. esbuild then just bundles
// the already-compiled plain JS.
rmSync('.tsc-out', { recursive: true, force: true });
execSync('npx tsc -p tsconfig.json --outDir .tsc-out', { stdio: 'inherit' });

await build({
  entryPoints: ['.tsc-out/lambda.js'],
  outfile: 'dist/lambda.js',
  bundle: true,
  platform: 'node',
  target: 'node26',
  // CJS avoids needing a "type": "module" package.json inside the deployed
  // zip — Lambda's Node runtime treats a bare .js file as CJS by default.
  format: 'cjs',
  external: [
    // Optional NestJS/Fastify peer deps we don't use; esbuild would otherwise try to resolve them.
    '@nestjs/microservices',
    '@nestjs/websockets',
    '@nestjs/platform-express',
    '@fastify/static',
    '@fastify/view',
    // @nestjs/mapped-types tries `require('class-transformer/cjs/storage')`
    // first and only falls back to this bare path in a catch block — this
    // installed class-transformer version has no root-level storage.js
    // (only cjs/esm variants), so esbuild can't resolve it statically.
    // Externalizing is safe: the primary require always succeeds, so this
    // fallback is unreachable at runtime.
    'class-transformer/storage',
  ],
  sourcemap: true,
  minify: true,
  // Minification mangles class names, which are what Nest prints as its log
  // context ("[e]" instead of "[SearchService]"). Keep them; the size cost is small.
  keepNames: true,
  logLevel: 'info',
});

rmSync('.tsc-out', { recursive: true, force: true });
