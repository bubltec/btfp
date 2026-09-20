import type { Contribution } from './contribution.js';
import { mergeThingPayload, thingsMatch, type ThingIdentity } from './thing-identity.js';

export function contributionIdentity(
  contribution: Pick<Contribution, 'payload'>,
): ThingIdentity | undefined {
  const name = contribution.payload?.name;
  const thingTypeId = contribution.payload?.thingTypeId;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (typeof thingTypeId !== 'string' || !thingTypeId.trim()) return undefined;
  return {
    name,
    thingTypeId,
    otherNames: contribution.payload.otherNames,
    details: contribution.payload.details,
  };
}

export function contributionsMatch(
  a: Pick<Contribution, 'payload' | 'thingId'>,
  b: Pick<Contribution, 'payload' | 'thingId'>,
): boolean {
  if (a.thingId && b.thingId && a.thingId === b.thingId) return true;
  const left = contributionIdentity(a);
  const right = contributionIdentity(b);
  if (!left || !right) return false;
  try {
    return thingsMatch(left, right);
  } catch {
    return false;
  }
}

export function findMatchingContribution<T extends Pick<Contribution, 'payload' | 'thingId'>>(
  pending: T[],
  candidate: Pick<Contribution, 'payload' | 'thingId'>,
): T | undefined {
  return pending.find((item) => contributionsMatch(item, candidate));
}

/** One queue row per identity: newest SK kept, older payloads folded in. */
export function clusterPendingContributions<T extends Contribution>(items: T[]): T[] {
  const ordered = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const used = new Set<number>();
  const clustered: T[] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (used.has(i)) continue;
    const newest = ordered[i]!;
    used.add(i);
    let payload = newest.payload;
    let thingId = newest.thingId;
    for (let j = i + 1; j < ordered.length; j++) {
      if (used.has(j)) continue;
      const other = ordered[j]!;
      if (!contributionsMatch(newest, other)) continue;
      used.add(j);
      payload = mergeThingPayload(payload, other.payload);
      thingId ??= other.thingId;
    }
    clustered.push({ ...newest, payload, thingId });
  }

  return clustered;
}

export function planContributionAttach(input: {
  payload: ThingIdentity;
  explicitThingId?: string;
  catalogMatchId?: string;
  pending: Contribution[];
}): { pendingMatch?: Contribution; thingId?: string } {
  const thingId = input.explicitThingId ?? input.catalogMatchId;
  const pendingMatch = findMatchingContribution(input.pending, {
    payload: input.payload,
    thingId,
  });
  return { pendingMatch, thingId: thingId ?? pendingMatch?.thingId };
}
