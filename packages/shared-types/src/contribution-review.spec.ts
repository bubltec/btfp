import { describe, expect, it } from 'vitest';
import {
  applyContributionToThing,
  diffThings,
  isReviewableContribution,
  previewContribution,
} from './contribution-review.js';
import type { Thing } from './thing.js';

const NOW = '2026-09-20T12:00:00.000Z';

const chocolate: Thing = {
  id: 't1',
  name: 'Chocolate',
  otherNames: ['Cocoa'],
  thingTypeId: 'food',
  petTypes: [{ petTypeId: 'dog', severity: 'mild' }],
  details: { notes: 'Toxic to dogs.' },
  source: 'aspca',
  sourceUrl: 'https://aspca.org/chocolate',
  verified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ctx = { fallbackId: 'new-id', contributorId: 'u1', now: NOW };

describe('isReviewableContribution', () => {
  it('needs both a name and a type', () => {
    expect(isReviewableContribution({ payload: { name: 'Grapes', thingTypeId: 'food' } })).toBe(
      true,
    );
    expect(isReviewableContribution({ payload: { thingTypeId: 'food' } })).toBe(false);
    expect(isReviewableContribution({ payload: { name: 'Grapes' } })).toBe(false);
    expect(isReviewableContribution({ payload: { name: '  ', thingTypeId: 'food' } })).toBe(false);
    expect(isReviewableContribution({ payload: {} })).toBe(false);
    expect(isReviewableContribution({} as never)).toBe(false);
  });
});

describe('applyContributionToThing', () => {
  it('creates a new Thing when there is nothing to merge into', () => {
    const thing = applyContributionToThing(
      null,
      { name: 'Grapes', thingTypeId: 'food', petTypes: [{ petTypeId: 'dog', severity: 'severe' }] },
      ctx,
    );
    expect(thing).toMatchObject({
      id: 'new-id',
      name: 'Grapes',
      verified: true,
      contributorId: 'u1',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('keeps the existing id, name and createdAt, and keeps the higher severity', () => {
    const thing = applyContributionToThing(
      chocolate,
      {
        name: 'Chocolate',
        thingTypeId: 'food',
        petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
      },
      ctx,
    );
    expect(thing.id).toBe('t1');
    expect(thing.createdAt).toBe(chocolate.createdAt);
    expect(thing.petTypes).toEqual([{ petTypeId: 'dog', severity: 'severe' }]);
    expect(thing.updatedAt).toBe(NOW);
  });
});

describe('diffThings', () => {
  it('reports nothing when nothing changes', () => {
    expect(diffThings(chocolate, chocolate)).toEqual([]);
  });

  it('lists every populated field as added for a new entry', () => {
    const after = applyContributionToThing(
      null,
      {
        name: 'Grapes',
        thingTypeId: 'food',
        petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
        details: { notes: 'Kidney failure.' },
        source: 'vet',
      },
      ctx,
    );
    const changes = diffThings(null, after);
    expect(changes.every((c) => c.kind === 'added')).toBe(true);
    expect(changes.map((c) => c.field)).toEqual([
      'name',
      'thingTypeId',
      'petTypes.dog',
      'details.notes',
      'source',
    ]);
  });

  it('reports a severity change and a new pet type', () => {
    const after = applyContributionToThing(
      chocolate,
      {
        name: 'Chocolate',
        thingTypeId: 'food',
        petTypes: [
          { petTypeId: 'dog', severity: 'severe' },
          { petTypeId: 'cat', severity: 'moderate' },
        ],
      },
      ctx,
    );
    const changes = diffThings(chocolate, after);
    expect(changes).toContainEqual({
      field: 'petTypes.dog',
      label: 'Dangerous for dog',
      kind: 'changed',
      before: 'mild',
      after: 'severe',
    });
    expect(changes).toContainEqual({
      field: 'petTypes.cat',
      label: 'Dangerous for cat',
      kind: 'added',
      after: 'moderate',
    });
  });

  it('shows a differently-named submission as a new alias, not an overwrite', () => {
    const after = applyContributionToThing(
      chocolate,
      { name: 'Dark chocolate', thingTypeId: 'food' },
      ctx,
    );
    const changes = diffThings(chocolate, after);
    expect(changes.find((c) => c.field === 'name')).toBeUndefined();
    expect(changes).toContainEqual({
      field: 'otherNames',
      label: 'Also known as',
      kind: 'added',
      after: 'Dark chocolate',
    });
  });

  it('shows a new detail with a humanized label', () => {
    const after = applyContributionToThing(
      chocolate,
      { name: 'Chocolate', thingTypeId: 'food', details: { trendTerm: 'xylitol' } },
      ctx,
    );
    expect(diffThings(chocolate, after)).toContainEqual({
      field: 'details.trendTerm',
      label: 'Trend term',
      kind: 'added',
      after: 'xylitol',
    });
  });

  it('does not show text the existing entry will keep: approval never overwrites a filled detail', () => {
    // mergeThings lets the existing value win, so a rewritten `notes` is NOT applied.
    // The preview must say so rather than promise a change approval will not make.
    const after = applyContributionToThing(
      chocolate,
      { name: 'Chocolate', thingTypeId: 'food', details: { notes: 'Totally different text.' } },
      ctx,
    );
    expect(diffThings(chocolate, after).find((c) => c.field === 'details.notes')).toBeUndefined();
    expect(after.details.notes).toBe('Toxic to dogs.');
  });
});

describe('previewContribution', () => {
  it('previews exactly what approval produces (same function, same result)', () => {
    const contribution = {
      id: 'c1',
      thingId: 't1',
      contributorId: 'u1',
      payload: {
        name: 'Chocolate',
        thingTypeId: 'food',
        petTypes: [{ petTypeId: 'dog', severity: 'severe' as const }],
      },
    };
    const approved = applyContributionToThing(chocolate, contribution.payload, {
      fallbackId: 't1',
      contributorId: 'u1',
      now: NOW,
    });
    expect(previewContribution(chocolate, contribution, NOW)).toEqual(
      diffThings(chocolate, approved),
    );
  });
});
