import { defineConfig } from 'vitest/config';

// cdk.out/ holds staged copies of other packages' sources (including their
// specs) as deploy assets — never collect those.
export default defineConfig({
  test: { include: ['lib/**/*.spec.ts'] },
});
