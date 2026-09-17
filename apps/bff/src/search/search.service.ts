import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Fuse from 'fuse.js';
import { findDuplicateThing, type Breed, type Thing, type ThingIdentity } from '@btfp/shared-types';
import { DYNAMO_DOC_CLIENT, stripDynamoKeys } from '@bubltec/mycota-dynamo';
import { CONTENT_TABLE_NAME } from '../dynamo/dynamo.constants.js';
import { COMMON_THING_NAMES } from './common-things.js';
import { BreedsService } from '../breeds/breeds.service.js';

const CACHE_TTL_MS = 60_000;

/**
 * A Thing entry with no `breedTraits` set applies to the whole species —
 * only entries that explicitly scope to a trait the breed doesn't have
 * get excluded.
 */
function matchesBreed(thing: Thing, breed: Breed): boolean {
  return thing.petTypes.some(
    (p) =>
      p.petTypeId === breed.petTypeId &&
      (!p.breedTraits?.length || p.breedTraits.some((trait) => breed.traits.includes(trait))),
  );
}

/** Dynamo rows can predate schema tightening; keep scans from throwing in findDuplicate. */
function sanitizeCatalogThing(thing: Thing & { PK?: string }): Thing {
  const { PK, ...rest } = thing;
  const idFromPk =
    typeof PK === 'string' && PK.startsWith('THING#') ? PK.slice('THING#'.length) : undefined;
  const id = typeof rest.id === 'string' && rest.id.trim() ? rest.id.trim() : (idFromPk ?? rest.id);
  return {
    ...rest,
    id: typeof id === 'string' ? id : '',
    name: typeof thing.name === 'string' ? thing.name : '',
    thingTypeId: typeof thing.thingTypeId === 'string' ? thing.thingTypeId : 'unknown',
    otherNames: Array.isArray(thing.otherNames)
      ? thing.otherNames.filter((name): name is string => typeof name === 'string')
      : [],
    petTypes: Array.isArray(thing.petTypes) ? thing.petTypes : [],
  };
}

/** Common things first (alphabetical among themselves), then the rest alphabetically. */
function sortByCommonality(things: Thing[]): Thing[] {
  return [...things].sort((a, b) => {
    const commonDiff =
      Number(COMMON_THING_NAMES.has(b.name)) - Number(COMMON_THING_NAMES.has(a.name));
    return commonDiff !== 0 ? commonDiff : (a.name ?? '').localeCompare(b.name ?? '');
  });
}

/**
 * Loads all Things into memory and searches/filters there instead of paying
 * for a managed search service. Fine at the current ~1000-row scale; see
 * docs/data-model.md for the upgrade path if this stops being true.
 */
@Injectable()
export class SearchService {
  private cache: { things: Thing[]; loadedAt: number } | null = null;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly breeds: BreedsService,
  ) {}

  async all(): Promise<Thing[]> {
    return sortByCommonality(await this.loadThings());
  }

  async filterByPetType(petTypeId: string): Promise<Thing[]> {
    const things = await this.loadThings();
    return sortByCommonality(
      things.filter((t) => t.petTypes.some((p) => p.petTypeId === petTypeId)),
    );
  }

  async filterByBreed(breedId: string): Promise<Thing[]> {
    const breed = await this.breeds.getById(breedId);
    if (!breed) throw new NotFoundException(`No breed with id ${breedId}`);

    const things = await this.loadThings();
    return sortByCommonality(things.filter((t) => matchesBreed(t, breed)));
  }

  async search(
    query: string,
    filters: { petType?: string; thingType?: string; breed?: string } = {},
  ): Promise<Thing[]> {
    let things = await this.loadThings();
    if (filters.breed) {
      const breed = await this.breeds.getById(filters.breed);
      if (!breed) throw new NotFoundException(`No breed with id ${filters.breed}`);
      things = things.filter((t) => matchesBreed(t, breed));
    } else if (filters.petType) {
      things = things.filter((t) => t.petTypes.some((p) => p.petTypeId === filters.petType));
    }
    if (filters.thingType) {
      things = things.filter((t) => t.thingTypeId === filters.thingType);
    }

    // 0.35 (Fuse's own default range for "loose") was letting short common
    // names cross-match on shared suffixes — e.g. "blueberry" fuzzy-matched
    // "Maleberry"/"Fetterbush"/"Staggerbush" (the latter two list each other
    // as otherNames aliases including "Staggerberry", which is where the
    // stray "berry" match came from). Verified empirically: 0.2 drops all
    // three false positives while still tolerating realistic typos
    // (missing/swapped letters) on this dataset's short food/plant names.
    const fuse = new Fuse(things, {
      keys: ['name', 'otherNames', 'details.scientificName', 'details.toxicPrinciples'],
      threshold: 0.2,
    });
    return fuse.search(query).map((r) => r.item);
  }

  /**
   * If `candidate` matches exactly one existing Thing (same type + name /
   * alias / scientific name / unique token containment), return it so
   * callers can attach an edit instead of creating a duplicate.
   */
  async findDuplicate(candidate: ThingIdentity): Promise<Thing | undefined> {
    return findDuplicateThing(await this.loadThings(), candidate);
  }

  invalidate(): void {
    this.cache = null;
  }

  private async loadThings(): Promise<Thing[]> {
    if (this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) {
      return this.cache.things;
    }

    const items: Thing[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(
        new ScanCommand({
          TableName: CONTENT_TABLE_NAME,
          FilterExpression: 'SK = :meta AND begins_with(PK, :thingPrefix)',
          ExpressionAttributeValues: { ':meta': 'META', ':thingPrefix': 'THING#' },
          ExclusiveStartKey: lastKey,
        }),
      );
      items.push(
        ...(result.Items ?? []).map((item) => {
          const pk = (item as { PK?: string }).PK;
          return sanitizeCatalogThing({
            ...(stripDynamoKeys(item) as Thing),
            PK: pk,
          });
        }),
      );
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    this.cache = { things: items, loadedAt: Date.now() };
    return items;
  }
}
