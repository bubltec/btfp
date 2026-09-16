import type { PetToxicity, Severity, Thing } from './thing.js';

export interface ThingIdentity {
  name: string;
  thingTypeId: string;
  otherNames?: string[];
  details?: Record<string, unknown>;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'or',
  'of',
  'a',
  'an',
  'to',
  'for',
  'in',
  'with',
  'spp',
  'sp',
  'some',
]);

const SEVERITY_RANK: Record<Severity, number> = {
  unknown: 0,
  mild: 1,
  moderate: 2,
  severe: 3,
};

/** Case/punctuation-insensitive form used for identity comparison. */
export function normalizeThingName(name: string): string {
  if (!name) return '';
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Strips rank/cultivar noise (`spp.`, `cv`, …) so `Narcissus spp` and
 * `Narcissus spp.` land on the same key. Returns null when nothing usable
 * remains.
 */
export function normalizeScientificName(sci: string | undefined | null): string | null {
  if (!sci) return null;
  const stripped = normalizeThingName(sci)
    .replace(/\b(spp|sp|species|var|cv|cultivar)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || null;
}

export function normalizedPrimaryName(name: string): string {
  return singularize(normalizeThingName(name));
}

function singularize(name: string): string {
  const words = name.split(' ').filter(Boolean);
  const last = words.at(-1);
  if (!last || last.length < 4) return name;
  if (last.endsWith('ies')) {
    words[words.length - 1] = `${last.slice(0, -3)}y`;
  } else if (
    last.endsWith('s') &&
    !last.endsWith('ss') &&
    !last.endsWith('us') &&
    !last.endsWith('is') &&
    !last.endsWith('os')
  ) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(' ');
}

function scientificNameOf(thing: ThingIdentity): string | null {
  const raw = thing.details?.scientificName;
  return typeof raw === 'string' ? normalizeScientificName(raw) : null;
}

function primaryKey(thing: ThingIdentity): string {
  return `${thing.thingTypeId}#name#${normalizedPrimaryName(thing.name)}`;
}

/** Hard identity keys — same key means the rows are the same Thing. */
export function hardIdentityKeys(thing: ThingIdentity): string[] {
  const keys = new Set<string>([primaryKey(thing)]);
  const sci = scientificNameOf(thing);
  if (sci) keys.add(`${thing.thingTypeId}#sci#${sci}`);
  return [...keys];
}

function aliasKeys(thing: ThingIdentity): string[] {
  return (thing.otherNames ?? [])
    .map((name) => normalizedPrimaryName(name))
    .filter(Boolean)
    .map((name) => `${thing.thingTypeId}#name#${name}`);
}

function nameTokens(name: string): Set<string> {
  return new Set(
    normalizedPrimaryName(name)
      .split(' ')
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  );
}

/** True when the smaller primary-name token set is fully contained in the larger. */
export function primaryTokensContained(a: ThingIdentity, b: ThingIdentity): boolean {
  if (a.thingTypeId !== b.thingTypeId) return false;
  const ta = nameTokens(a.name);
  const tb = nameTokens(b.name);
  if (ta.size === 0 || tb.size === 0) return false;
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (![...smaller].some((token) => token.length >= 4)) return false;
  for (const token of smaller) {
    if (!larger.has(token)) return false;
  }
  return true;
}

function primaryMatchesAlias(primary: ThingIdentity, other: ThingIdentity): boolean {
  if (primary.thingTypeId !== other.thingTypeId) return false;
  const key = primaryKey(primary);
  return aliasKeys(other).includes(key);
}

function hardKeysOverlap(a: ThingIdentity, b: ThingIdentity): boolean {
  if (a.thingTypeId !== b.thingTypeId) return false;
  const aSci = scientificNameOf(a);
  const bSci = scientificNameOf(b);
  if (aSci && bSci && aSci !== bSci) return false;
  const keys = new Set(hardIdentityKeys(a));
  return hardIdentityKeys(b).some((key) => keys.has(key));
}

/**
 * Pairwise "are these the same Thing?" — used to attach a new contribution
 * to an existing row. Callers that see more than one match should treat
 * that as ambiguous and not auto-link.
 */
export function thingsMatch(a: ThingIdentity, b: ThingIdentity): boolean {
  if (!a.name?.trim() || !b.name?.trim()) return false;
  if (a.thingTypeId !== b.thingTypeId) return false;
  return (
    hardKeysOverlap(a, b) ||
    primaryMatchesAlias(a, b) ||
    primaryMatchesAlias(b, a) ||
    primaryTokensContained(a, b)
  );
}

export function findDuplicateThing<T extends ThingIdentity>(
  existing: T[],
  candidate: ThingIdentity,
): T | undefined {
  const matches = existing.filter((thing) => thingsMatch(thing, candidate));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return undefined;
  const candidatePrimary = primaryKey(candidate);
  const exact = matches.filter((thing) => primaryKey(thing) === candidatePrimary);
  return exact.length === 1 ? exact[0] : undefined;
}

function uniqueNames(canonicalName: string, names: string[]): string[] {
  const seen = new Set([normalizeThingName(canonicalName)]);
  const result: string[] = [];
  for (const name of names) {
    const normalized = normalizeThingName(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(name);
  }
  return result;
}

function mergePetTypes(canonical: PetToxicity[], extra: PetToxicity[]): PetToxicity[] {
  const byId = new Map(canonical.map((pet) => [pet.petTypeId, { ...pet }]));
  for (const pet of extra) {
    const existing = byId.get(pet.petTypeId);
    if (!existing) {
      byId.set(pet.petTypeId, { ...pet });
      continue;
    }
    if (SEVERITY_RANK[pet.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = pet.severity;
    }
    if (pet.breedTraits?.length) {
      existing.breedTraits = [...new Set([...(existing.breedTraits ?? []), ...pet.breedTraits])];
    }
  }
  return [...byId.values()];
}

function isEmptyDetail(value: unknown): boolean {
  return value == null || value === '';
}

function mergeDetails(
  canonical: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const details = { ...extra, ...canonical };
  for (const [key, value] of Object.entries(extra)) {
    if (isEmptyDetail(canonical[key]) && !isEmptyDetail(value)) details[key] = value;
  }
  return details;
}

/** Fold `extra` into `canonical`, keeping canonical id/name/source. */
export function mergeThings(canonical: Thing, extra: Thing): Thing {
  return {
    ...canonical,
    otherNames: uniqueNames(canonical.name, [
      ...canonical.otherNames,
      extra.name,
      ...extra.otherNames,
    ]),
    petTypes: mergePetTypes(canonical.petTypes, extra.petTypes),
    details: mergeDetails(canonical.details, extra.details),
    sourceUrl: canonical.sourceUrl ?? extra.sourceUrl,
    verified: canonical.verified || extra.verified,
    contributorId: canonical.contributorId ?? extra.contributorId,
  };
}
