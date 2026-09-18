import { describe, expect, it } from 'vitest';
import { dedupeThings } from './dedupe.js';
import type { Thing } from './thing.js';

function makeThing(overrides: Partial<Thing> & Pick<Thing, 'id' | 'name' | 'thingTypeId'>): Thing {
  return {
    otherNames: [],
    petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
    details: {},
    source: 'test',
    verified: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('dedupeThings', () => {
  it('merges two rows that share a stable id (same thingTypeId+name from different sources)', () => {
    // stableId() in data/seed/src/transform.ts hashes thingTypeId+name, so two
    // sources describing the same item by the same name legitimately collide
    // on `id` — merging must not key off `.id` or it silently drops one side.
    const aspca = makeThing({
      id: 'same-hash',
      name: 'Garlic',
      thingTypeId: 'food',
      source: 'aspca',
      petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
      details: { doseConcern: 'a few cloves' },
    });
    const vetmeds = makeThing({
      id: 'same-hash',
      name: 'Garlic',
      thingTypeId: 'food',
      source: 'vetmeds',
      petTypes: [
        { petTypeId: 'dog', severity: 'unknown' },
        { petTypeId: 'cat', severity: 'unknown' },
      ],
      details: { clinicalSigns: 'vomiting, diarrhea' },
    });

    const { things, discarded } = dedupeThings([aspca, vetmeds]);

    expect(things).toHaveLength(1);
    expect(discarded).toHaveLength(1);
    const merged = things[0]!;
    // Higher severity wins, cat pet type carried over, and both sources'
    // details are present — neither source's info was dropped.
    expect(merged.petTypes).toContainEqual({ petTypeId: 'dog', severity: 'severe' });
    expect(merged.petTypes).toContainEqual({ petTypeId: 'cat', severity: 'unknown' });
    expect(merged.details.doseConcern).toBe('a few cloves');
    expect(merged.details.clinicalSigns).toBe('vomiting, diarrhea');
  });

  it('does not fold a specific species into a genus/umbrella entry that happens to name it in prose', () => {
    // Regression for the "Onions, garlic, leeks, chives, shallots (Allium
    // spp.)" combo entry: a genus-level row must not literally spell out
    // member names in `name`, or token-containment matching re-merges the
    // individual species back into one combo row.
    const onion = makeThing({ id: 'onion', name: 'Onion', thingTypeId: 'food' });
    const genus = makeThing({
      id: 'allium',
      name: 'Allium (unidentified species)',
      thingTypeId: 'food',
      details: { notes: 'Includes onion, garlic, leeks, chives, and shallot.' },
    });

    const { things, discarded } = dedupeThings([onion, genus]);

    expect(things).toHaveLength(2);
    expect(discarded).toHaveLength(0);
    expect(things.map((t) => t.name).sort()).toEqual(['Allium (unidentified species)', 'Onion']);
  });

  it('keeps distinct species as separate things instead of one combo row', () => {
    const things: Thing[] = [
      makeThing({ id: '1', name: 'Onion', thingTypeId: 'food' }),
      makeThing({ id: '2', name: 'Garlic', thingTypeId: 'food' }),
      makeThing({ id: '3', name: 'Chives', thingTypeId: 'food' }),
    ];

    const result = dedupeThings(things);

    expect(result.things).toHaveLength(3);
    expect(result.discarded).toHaveLength(0);
  });

  it('still collapses same-species entries carrying obvious alias overlap', () => {
    const canonical = makeThing({
      id: '1',
      name: 'Garlic',
      thingTypeId: 'food',
      otherNames: ['Allium sativum'],
    });
    const alias = makeThing({ id: '2', name: 'Allium Sativum', thingTypeId: 'food' });

    const { things, discarded } = dedupeThings([canonical, alias]);

    expect(things).toHaveLength(1);
    expect(discarded).toHaveLength(1);
  });
});
