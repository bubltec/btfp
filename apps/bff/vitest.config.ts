import { configDefaults, defineConfig } from 'vitest/config';

// Vitest 3+ no longer excludes build output. The Lambda bundle build compiles into
// .tsc-out while turbo runs the tests in parallel, so half-written *.spec.js copies
// get collected and fail with "Cannot find module".
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/.tsc-out/**', '**/dist*/**'] },
});
