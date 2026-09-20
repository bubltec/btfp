import { describe, expect, it } from 'vitest';
import type { Contribution } from './contribution.js';
import {
  clusterPendingContributions,
  findMatchingContribution,
  planContributionAttach,
} from './contribution-queue.js';
import { mergeThingPayload } from './thing-identity.js';

function pending(
  overrides: Partial<Contribution> & Pick<Contribution, 'id' | 'createdAt'>,
): Contribution {
  return {
    contributorId: 'user',
    status: 'pending',
    payload: { name: 'Chocolate', thingTypeId: 'food' },
    ...overrides,
  };
}

describe('clusterPendingContributions', () => {
  it('folds duplicate Chocolate queue rows into the newest card', () => {
    const clustered = clusterPendingContributions([
      pending({
        id: 'a',
        createdAt: '2026-01-01T00:00:00.000Z',
        thingId: 'choc',
        payload: { name: 'Chocolate', thingTypeId: 'food', details: { notes: 'theobromine' } },
      }),
      pending({
        id: 'b',
        createdAt: '2026-01-02T00:00:00.000Z',
        thingId: 'choc',
        payload: { name: 'Chocolate', thingTypeId: 'food', details: { notes: 'theobromine' } },
      }),
      pending({
        id: 'c',
        createdAt: '2026-01-03T00:00:00.000Z',
        payload: { name: 'Xylitol', thingTypeId: 'food' },
      }),
    ]);

    expect(clustered).toHaveLength(2);
    expect(clustered[0]?.id).toBe('c');
    expect(clustered[1]?.id).toBe('b');
    expect(clustered[1]?.payload.details).toEqual({ notes: 'theobromine' });
  });

  it('accumulates new details instead of repeating the same text', () => {
    const merged = mergeThingPayload(
      { name: 'Chocolate', thingTypeId: 'food', details: { notes: 'theobromine' } },
      {
        name: 'Chocolate',
        thingTypeId: 'food',
        details: { notes: 'theobromine', clinicalSigns: 'vomiting' },
      },
    );
    expect(merged.details).toEqual({ notes: 'theobromine', clinicalSigns: 'vomiting' });
  });
});

describe('planContributionAttach', () => {
  it('updates an existing pending row for the same live Thing', () => {
    const existing = pending({
      id: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      thingId: 'choc',
    });
    const plan = planContributionAttach({
      payload: { name: 'Chocolate', thingTypeId: 'food' },
      catalogMatchId: 'choc',
      pending: [existing],
    });
    expect(plan.pendingMatch?.id).toBe('queued');
    expect(plan.thingId).toBe('choc');
  });

  it('matches by identity when thingId is not set yet', () => {
    const existing = pending({ id: 'queued', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(
      findMatchingContribution([existing], {
        payload: { name: 'chocolate', thingTypeId: 'food' },
      })?.id,
    ).toBe('queued');
  });
});
