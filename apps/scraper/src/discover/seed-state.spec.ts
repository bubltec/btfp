import { describe, expect, it } from 'vitest';
import { isSeedDue, nextSeedState } from './seed-state.js';

const now = new Date('2026-09-27T00:00:00Z');
const hours = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();

describe('seed state', () => {
  it('treats a first search as fresh with no backoff', () => {
    const { state, fresh } = nextSeedState(undefined, ['u1'], now);
    expect(fresh).toBe(true);
    expect(state).toEqual({ knownUrls: ['u1'], staleRuns: 0 });
    expect(isSeedDue(state, now)).toBe(true);
  });

  it('doubles the backoff each run nothing new comes back, capped at a week', () => {
    let state = nextSeedState(undefined, ['u1'], now).state;
    const waits: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = nextSeedState(state, ['u1'], now);
      expect(next.fresh).toBe(false);
      state = next.state;
      waits.push(state.nextSearchAt!);
    }
    expect(waits).toEqual([hours(12), hours(24), hours(48), hours(96), hours(168), hours(168)]);
    expect(isSeedDue(state, now)).toBe(false);
    expect(isSeedDue(state, new Date(hours(168)))).toBe(true);
  });

  it('resets the backoff when a new page shows up', () => {
    const stale = nextSeedState({ knownUrls: ['u1'], staleRuns: 3 }, ['u1'], now).state;
    const { state, fresh } = nextSeedState(stale, ['u1', 'u2'], now);
    expect(fresh).toBe(true);
    expect(state.staleRuns).toBe(0);
    expect(state.nextSearchAt).toBeUndefined();
    expect(state.knownUrls.sort()).toEqual(['u1', 'u2']);
  });
});
