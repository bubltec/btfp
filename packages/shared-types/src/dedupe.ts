import type { Thing } from './thing.js';
import {
  hardIdentityKeys,
  mergeThings,
  normalizeScientificName,
  normalizedPrimaryName,
  primaryTokensContained,
  type ThingIdentity,
} from './thing-identity.js';

export interface DedupeResult {
  things: Thing[];
  discarded: Thing[];
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(index: number): number {
    let current = index;
    while (this.parent[current] !== current) {
      const parent = this.parent[current]!;
      this.parent[current] = this.parent[parent]!;
      current = this.parent[current]!;
    }
    return current;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

function scientificNameOf(thing: ThingIdentity): string | null {
  const raw = thing.details?.scientificName;
  return typeof raw === 'string' ? normalizeScientificName(raw) : null;
}

function clusterScientificNames(uf: UnionFind, things: Thing[], index: number): Set<string> {
  const root = uf.find(index);
  const names = new Set<string>();
  for (let i = 0; i < things.length; i++) {
    if (uf.find(i) !== root) continue;
    const sci = scientificNameOf(things[i]!);
    if (sci) names.add(sci);
  }
  return names;
}

function canUnion(uf: UnionFind, things: Thing[], a: number, b: number): boolean {
  const combined = new Set([
    ...clusterScientificNames(uf, things, a),
    ...clusterScientificNames(uf, things, b),
  ]);
  return combined.size <= 1;
}

function aliasNormalized(thing: Thing): Set<string> {
  return new Set(
    (thing.otherNames ?? []).map((name) => normalizedPrimaryName(name)).filter(Boolean),
  );
}

function primaryNormalized(thing: Thing): string {
  return normalizedPrimaryName(thing.name);
}

function pickCanonical(group: Thing[]): Thing {
  const aliasCounts = new Map<string, number>();
  for (const thing of group) {
    for (const alias of aliasNormalized(thing)) {
      aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
    }
  }

  const scored = [...group].map((thing) => {
    const name = thing.name;
    let score = 0;
    if (/\s+\d+$/.test(name)) score -= 1000;
    score += (aliasCounts.get(primaryNormalized(thing)) ?? 0) * 50;
    if (scientificNameOf(thing)) score += 10;
    score += thing.otherNames.length;
    // A one-token name contained in a longer name ("Chocolate" ⊂
    // "Chocolate / cocoa") is a variant — keep the more specific row.
    const tokenCount = primaryNormalized(thing).split(' ').filter(Boolean).length;
    if (
      tokenCount > 1 &&
      group.some(
        (other) =>
          other !== thing &&
          primaryNormalized(other).split(' ').filter(Boolean).length === 1 &&
          primaryTokensContained(other, thing),
      )
    ) {
      score += 200;
    }
    score -= name.length;
    return { thing, score };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.thing.name.localeCompare(b.thing.name) ||
      a.thing.id.localeCompare(b.thing.id),
  );
  return scored[0]!.thing;
}

function indexByKey(things: Thing[], keysFor: (thing: Thing) => string[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < things.length; i++) {
    for (const key of keysFor(things[i]!)) {
      const list = index.get(key) ?? [];
      list.push(i);
      index.set(key, list);
    }
  }
  return index;
}

/**
 * Collapse duplicate Things from overlapping seed sources (same species
 * listed under every common name, ASPCA vs vetmeds spelling variants, …).
 *
 * Scientific-name matches always merge. Primary-name matches merge unless
 * that would join two different species. Soft matches (primary equals an
 * alias, or one primary-name token-set contains the other) only attach
 * when the match is unique — so "Ibuprofen & Naproxen" is left alone
 * rather than collapsing two distinct medications.
 */
export function dedupeThings(things: Thing[]): DedupeResult {
  if (things.length < 2) return { things: [...things], discarded: [] };

  const uf = new UnionFind(things.length);

  const sciIndex = indexByKey(things, (thing) =>
    hardIdentityKeys(thing).filter((key) => key.includes('#sci#')),
  );
  for (const indices of sciIndex.values()) {
    for (let i = 1; i < indices.length; i++) uf.union(indices[0]!, indices[i]!);
  }

  const nameIndex = indexByKey(things, (thing) =>
    hardIdentityKeys(thing).filter((key) => key.includes('#name#')),
  );
  for (const indices of nameIndex.values()) {
    for (let i = 1; i < indices.length; i++) {
      const a = indices[0]!;
      const b = indices[i]!;
      if (canUnion(uf, things, a, b)) uf.union(a, b);
    }
  }

  const attachIfUnique = (index: number, matches: number[]): void => {
    const uniqueRoots = new Set(matches.filter((m) => m !== index).map((m) => uf.find(m)));
    if (uniqueRoots.size !== 1) return;
    const [target] = uniqueRoots;
    if (target == null) return;
    // Map the target root back to a member index for canUnion.
    const member = matches.find((m) => m !== index && uf.find(m) === target);
    if (member == null) return;
    if (canUnion(uf, things, index, member)) uf.union(index, member);
  };

  for (let i = 0; i < things.length; i++) {
    const candidate = things[i]!;
    const aliasMatches: number[] = [];
    const tokenMatches: number[] = [];
    const candidatePrimary = primaryNormalized(candidate);
    if (!candidatePrimary) continue;

    for (let j = 0; j < things.length; j++) {
      if (i === j) continue;
      const other = things[j]!;
      if (other.thingTypeId !== candidate.thingTypeId) continue;
      if (aliasNormalized(other).has(candidatePrimary)) aliasMatches.push(j);
      if (primaryTokensContained(candidate, other)) tokenMatches.push(j);
    }

    attachIfUnique(i, aliasMatches);
    attachIfUnique(i, tokenMatches);
  }

  const groups = new Map<number, Thing[]>();
  for (let i = 0; i < things.length; i++) {
    const root = uf.find(i);
    const group = groups.get(root) ?? [];
    group.push(things[i]!);
    groups.set(root, group);
  }

  const kept: Thing[] = [];
  const discarded: Thing[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]!);
      continue;
    }
    const canonical = pickCanonical(group);
    let merged = canonical;
    for (const thing of group) {
      if (thing.id === canonical.id) continue;
      merged = mergeThings(merged, thing);
      discarded.push(thing);
    }
    kept.push(merged);
  }

  kept.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { things: kept, discarded };
}
