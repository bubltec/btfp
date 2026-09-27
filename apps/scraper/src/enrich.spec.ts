import { describe, expect, it } from 'vitest';
import { fillsGap, rankEnrichmentTargets, severityGaps } from './enrich.js';
import type { CatalogThing } from './taxonomy.js';

function thing(name: string, petTypes: CatalogThing['petTypes']): CatalogThing {
  return { id: name.toLowerCase(), name, thingTypeId: 'plant', otherNames: [], petTypes };
}

describe('enrich', () => {
  it('treats unknown and missing pet types as gaps', () => {
    const t = thing('Lily', [
      { petTypeId: 'cat', severity: 'severe' },
      { petTypeId: 'dog', severity: 'unknown' },
    ]);
    expect(severityGaps(t, ['dog', 'cat', 'horse'])).toEqual(['dog', 'horse']);
  });

  it('ranks dog/cat gaps before horse-only gaps, then by gap count', () => {
    const horseOnly = thing('Aaa', [
      { petTypeId: 'dog', severity: 'severe' },
      { petTypeId: 'cat', severity: 'severe' },
    ]);
    const catOnly = thing('Bbb', [
      { petTypeId: 'dog', severity: 'severe' },
      { petTypeId: 'horse', severity: 'mild' },
    ]);
    const allUnknown = thing('Ccc', []);
    const complete = thing('Ddd', [
      { petTypeId: 'dog', severity: 'mild' },
      { petTypeId: 'cat', severity: 'mild' },
      { petTypeId: 'horse', severity: 'mild' },
    ]);
    const ranked = rankEnrichmentTargets(
      [horseOnly, catOnly, allUnknown, complete],
      ['dog', 'cat', 'horse'],
    );
    expect(ranked.map((t) => t.thing.name)).toEqual(['Ccc', 'Bbb', 'Aaa']);
  });

  it('only counts a known severity for a missing pet type from a trusted report', () => {
    const base = { isPetHazardReport: true, confidence: 'high' as const };
    expect(fillsGap({ ...base, petTypes: [{ petTypeId: 'cat', severity: 'mild' }] }, ['cat'])).toBe(
      true,
    );
    expect(
      fillsGap({ ...base, petTypes: [{ petTypeId: 'cat', severity: 'unknown' }] }, ['cat']),
    ).toBe(false);
    expect(fillsGap({ ...base, petTypes: [{ petTypeId: 'dog', severity: 'mild' }] }, ['cat'])).toBe(
      false,
    );
    expect(
      fillsGap({ ...base, confidence: 'low', petTypes: [{ petTypeId: 'cat', severity: 'mild' }] }, [
        'cat',
      ]),
    ).toBe(false);
  });
});
