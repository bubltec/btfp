import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const controllerPath = join(dirname(fileURLToPath(import.meta.url)), 'contributions.controller.ts');

/**
 * Vitest runs TS directly (no emitDecoratorMetadata). tsc must emit
 * design:paramtypes [CreateContributionDto, …] — see contributions.controller.ts.
 */
describe('ContributionsController', () => {
  it('imports CreateContributionDto as a value (not import type)', () => {
    const src = readFileSync(controllerPath, 'utf8');
    expect(src).toContain("from './dto/create-contribution.dto.js'");
    expect(src).not.toMatch(/import type \{ CreateContributionDto \}/);
  });
});
