import type { Contribution } from './contribution.js';
import { contributionIdentity } from './contribution-queue.js';
import type { PetToxicity, Thing } from './thing.js';
import { mergeThings } from './thing-identity.js';

/** A pending row a moderator can act on: it has a name and a type. */
export function isReviewableContribution(item: Pick<Contribution, 'payload'>): boolean {
  return contributionIdentity(item) !== undefined;
}

export interface ApplyContext {
  /** Used as the new Thing's id when there is no existing Thing. */
  fallbackId: string;
  contributorId: string;
  now: string;
}

/**
 * The Thing that approving `payload` produces. `approve()` and the moderation preview
 * both call this, so the diff a moderator sees is exactly what approval will do.
 */
export function applyContributionToThing(
  existing: Thing | null,
  payload: Partial<Thing>,
  ctx: ApplyContext,
): Thing {
  const incoming: Thing = {
    id: existing?.id ?? ctx.fallbackId,
    name: payload.name ?? existing?.name ?? 'Unnamed',
    otherNames: payload.otherNames ?? existing?.otherNames ?? [],
    thingTypeId: payload.thingTypeId ?? existing?.thingTypeId ?? 'unknown',
    petTypes: payload.petTypes ?? existing?.petTypes ?? [],
    details: payload.details ?? {},
    source: payload.source ?? existing?.source ?? `contributor:${ctx.contributorId}`,
    sourceUrl: payload.sourceUrl ?? existing?.sourceUrl,
    verified: true,
    contributorId: ctx.contributorId,
    createdAt: existing?.createdAt ?? ctx.now,
    updatedAt: ctx.now,
  };
  if (!existing) return incoming;
  return {
    ...mergeThings(existing, incoming),
    verified: true,
    contributorId: ctx.contributorId,
    updatedAt: ctx.now,
  };
}

export interface FieldChange {
  field: string;
  label: string;
  kind: 'added' | 'changed' | 'removed';
  before?: string;
  after?: string;
}

/** What a moderator sees on a queue card. */
export interface ContributionPreview {
  changes: FieldChange[];
  /** The existing entry approval will merge into, when there is one. */
  mergesInto?: { id: string; name: string };
  /** The card links to an entry that no longer exists, so approval creates a new one. */
  targetMissing?: boolean;
  /** The preview could not be built (bad legacy data); the card can still be actioned. */
  unavailable?: boolean;
}

export type PendingContributionCard = Contribution & {
  PK?: string;
  SK?: string;
  preview: ContributionPreview;
};

const EMPTY: Thing = {
  id: '',
  name: '',
  otherNames: [],
  thingTypeId: '',
  petTypes: [],
  details: {},
  source: '',
  verified: false,
  createdAt: '',
  updatedAt: '',
};

function isBlank(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function scalar(
  field: string,
  label: string,
  before: string | undefined,
  after: string | undefined,
): FieldChange[] {
  if ((before ?? '') === (after ?? '')) return [];
  if (isBlank(before)) return [{ field, label, kind: 'added', after }];
  if (isBlank(after)) return [{ field, label, kind: 'removed', before }];
  return [{ field, label, kind: 'changed', before, after }];
}

function petLabel(pet: PetToxicity): string {
  const traits = pet.breedTraits?.length ? ` (${pet.breedTraits.join(', ')})` : '';
  return `${pet.severity}${traits}`;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Field-level differences between an entry and what it would become. `before` null means new. */
export function diffThings(before: Thing | null, after: Thing): FieldChange[] {
  const b = before ?? EMPTY;
  const changes: FieldChange[] = [
    ...scalar('name', 'Name', b.name, after.name),
    ...scalar('thingTypeId', 'Type', b.thingTypeId, after.thingTypeId),
  ];

  const beforeNames = new Set(b.otherNames.map(nameKey));
  const afterNames = new Set(after.otherNames.map(nameKey));
  const addedNames = after.otherNames.filter((n) => !beforeNames.has(nameKey(n)));
  const removedNames = b.otherNames.filter((n) => !afterNames.has(nameKey(n)));
  if (addedNames.length) {
    changes.push({
      field: 'otherNames',
      label: 'Also known as',
      kind: 'added',
      after: addedNames.join(', '),
    });
  }
  if (removedNames.length) {
    changes.push({
      field: 'otherNames',
      label: 'Also known as',
      kind: 'removed',
      before: removedNames.join(', '),
    });
  }

  const beforePets = new Map(b.petTypes.map((p) => [p.petTypeId, p]));
  const afterPets = new Map(after.petTypes.map((p) => [p.petTypeId, p]));
  for (const id of new Set([...afterPets.keys(), ...beforePets.keys()])) {
    const was = beforePets.get(id);
    const now = afterPets.get(id);
    const label = `Dangerous for ${id}`;
    if (was && now) {
      if (petLabel(was) !== petLabel(now)) {
        changes.push({
          field: `petTypes.${id}`,
          label,
          kind: 'changed',
          before: petLabel(was),
          after: petLabel(now),
        });
      }
    } else if (now) {
      changes.push({ field: `petTypes.${id}`, label, kind: 'added', after: petLabel(now) });
    } else if (was) {
      changes.push({ field: `petTypes.${id}`, label, kind: 'removed', before: petLabel(was) });
    }
  }

  for (const key of new Set([...Object.keys(after.details), ...Object.keys(b.details)])) {
    const was = b.details[key];
    const now = after.details[key];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    const field = `details.${key}`;
    const label = humanize(key);
    if (isBlank(was)) changes.push({ field, label, kind: 'added', after: show(now) });
    else if (isBlank(now)) changes.push({ field, label, kind: 'removed', before: show(was) });
    else changes.push({ field, label, kind: 'changed', before: show(was), after: show(now) });
  }

  changes.push(
    ...scalar('source', 'Source', b.source, after.source),
    ...scalar('sourceUrl', 'Source link', b.sourceUrl, after.sourceUrl),
  );
  return changes;
}

/** The change list for a queue card: what approving this contribution would do to `existing`. */
export function previewContribution(
  existing: Thing | null,
  contribution: Pick<Contribution, 'id' | 'thingId' | 'contributorId' | 'payload'>,
  now: string,
): FieldChange[] {
  const after = applyContributionToThing(existing, contribution.payload, {
    fallbackId: contribution.thingId ?? contribution.id,
    contributorId: contribution.contributorId,
    now,
  });
  return diffThings(existing, after);
}
