import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONTENT_TABLE_NAME } from './dynamo.js';
import type { ExtractionResult } from './extract/types.js';
import type { CatalogThing } from './taxonomy.js';

/** Most visitors have one of these, so their gaps are filled first. */
const PRIORITY_PET_TYPES = ['dog', 'cat'];

/** A thing that found nothing new is not searched again for this long. */
export const ENRICH_RETRY_DAYS = 30;

export interface EnrichmentTarget {
  thing: CatalogThing;
  /** Pet types the thing has no known severity for. */
  gaps: string[];
}

/** Pet types in the taxonomy that the thing is missing or has as "unknown". */
export function severityGaps(thing: CatalogThing, petTypeIds: string[]): string[] {
  const known = new Set(
    thing.petTypes.filter((pet) => pet.severity !== 'unknown').map((pet) => pet.petTypeId),
  );
  return petTypeIds.filter((id) => id !== 'unknown' && !known.has(id));
}

/** Things with dog/cat gaps first, then the most gaps, then by name so runs walk the list in a stable order. */
export function rankEnrichmentTargets(
  catalog: CatalogThing[],
  petTypeIds: string[],
): EnrichmentTarget[] {
  const priorityGaps = (gaps: string[]) =>
    gaps.filter((id) => PRIORITY_PET_TYPES.includes(id)).length;
  return catalog
    .map((thing) => ({ thing, gaps: severityGaps(thing, petTypeIds) }))
    .filter((target) => target.gaps.length > 0)
    .sort(
      (a, b) =>
        priorityGaps(b.gaps) - priorityGaps(a.gaps) ||
        b.gaps.length - a.gaps.length ||
        a.thing.name.localeCompare(b.thing.name),
    );
}

/**
 * Whether the extraction gives a known severity for a pet type the thing is missing. Anything
 * else would be a moderation card that changes nothing.
 */
export function fillsGap(extraction: ExtractionResult, gaps: string[]): boolean {
  return Boolean(
    extraction.isPetHazardReport &&
    extraction.confidence !== 'low' &&
    extraction.petTypes?.some((pet) => gaps.includes(pet.petTypeId) && pet.severity !== 'unknown'),
  );
}

/** PK: SCRAPERENRICH#{thingId}, SK: META. */
export async function wasRecentlyEnriched(
  db: DynamoDBDocumentClient,
  thingId: string,
  now: Date,
): Promise<boolean> {
  const result = await db.send(
    new GetCommand({ TableName: CONTENT_TABLE_NAME, Key: { PK: enrichKey(thingId), SK: 'META' } }),
  );
  const attemptedAt = result.Item?.attemptedAt;
  if (typeof attemptedAt !== 'string') return false;
  return now.getTime() - Date.parse(attemptedAt) < ENRICH_RETRY_DAYS * 86_400_000;
}

export async function markEnriched(
  db: DynamoDBDocumentClient,
  target: EnrichmentTarget,
  outcome: string,
  now: Date,
): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: CONTENT_TABLE_NAME,
      Item: {
        PK: enrichKey(target.thing.id),
        SK: 'META',
        thingId: target.thing.id,
        name: target.thing.name,
        gaps: target.gaps,
        outcome,
        attemptedAt: now.toISOString(),
      },
    }),
  );
}

export function enrichKey(thingId: string): string {
  return `SCRAPERENRICH#${thingId}`;
}
