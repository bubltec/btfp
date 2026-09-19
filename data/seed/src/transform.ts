import { createHash } from 'node:crypto';
import type {
  Breed,
  BreedTrait,
  PetToxicity,
  PetType,
  Severity,
  Thing,
  ThingType,
} from '@btfp/shared-types';

export interface RawDataset {
  metadata: {
    plant_source: string;
    food_medication_sources: string;
  };
  plants_toxic_to_dogs: RawPlant[];
  foods: RawFoodOrMedication[];
  medications: RawFoodOrMedication[];
}

interface RawPlant {
  name: string;
  other_common_names: string[];
  scientific_name: string;
  family: string | null;
  aspca_url: string;
  toxic_principles: string;
  clinical_signs: string;
  also_toxic_to: string[];
}

interface RawFoodOrMedication {
  name: string;
  severity: string;
  [key: string]: unknown;
}

// Dataset's also_toxic_to values are plural ("Cats", "Horses"); our PetType
// ids are singular to match the seeded PET_TYPES below.
const ALSO_TOXIC_TO_PET_TYPE_ID: Record<string, string> = {
  Cats: 'cat',
  Horses: 'horse',
};

function stableId(thingTypeId: string, name: string): string {
  return createHash('sha1').update(`${thingTypeId}:${name}`).digest('hex').slice(0, 16);
}

function normalizeSeverity(raw: string | undefined): Severity {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('severe') || lower.includes('lethal')) return 'severe';
  if (lower.includes('moderate')) return 'moderate';
  if (lower.includes('mild')) return 'mild';
  return 'unknown';
}

function stamp<T extends { createdAt: string; updatedAt: string }>(item: T): T {
  const now = new Date().toISOString();
  return { ...item, createdAt: now, updatedAt: now };
}

export const PET_TYPES: PetType[] = [
  { id: 'dog', name: 'Dog', aliases: [], details: {}, createdAt: '', updatedAt: '' },
  { id: 'cat', name: 'Cat', aliases: [], details: {}, createdAt: '', updatedAt: '' },
  { id: 'horse', name: 'Horse', aliases: [], details: {}, createdAt: '', updatedAt: '' },
].map(stamp);

export const THING_TYPES: ThingType[] = [
  {
    id: 'plant',
    name: 'Plant',
    description: 'Houseplants, garden plants, and flowers.',
    details: {},
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'food',
    name: 'Food',
    description: 'Human foods and drinks.',
    details: {},
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'medication',
    name: 'Medication',
    description: 'Human and veterinary medications.',
    details: {},
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'product',
    name: 'Product',
    description: 'Pet gear, household products, and other items.',
    details: {},
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'activity',
    name: 'Activity',
    description: 'Situations and activities that put pets at risk.',
    details: {},
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'object',
    name: 'Object',
    description: 'Non-food items pets swallow — choking and obstruction risk, not toxicity.',
    details: {},
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'drug',
    name: 'Illicit & Recreational Drug',
    description: 'Illicit and recreational drugs — distinct from medication (prescribed/OTC).',
    details: {},
    createdAt: '',
    updatedAt: '',
  },
].map(stamp);

export function transformDataset(raw: RawDataset): Thing[] {
  const things: Thing[] = [];

  // ASPCA's own dataset double-lists a handful of culinary Alliums (Onion,
  // Garlic, Leek, Chives) on both its toxic-plants list and its foods list —
  // same species, same hazard, just entered from two angles (garden plant
  // vs. dietary ingredient). dedupeThings only merges matching
  // thingTypeId+name, so left as 'plant' these would sit forever as a
  // separate, strictly-inferior duplicate card (no severity/dose data,
  // since only the foods list carries that) next to the real entry. Route
  // any plant whose name matches a foods-list entry into thingTypeId
  // 'food' instead, so it merges into the same canonical row — this keeps
  // the plant listing's unique cat/horse also_toxic_to flags (the foods
  // list here is dog-only) without producing a duplicate card. Generic on
  // name match rather than a hardcoded species list, so a future ASPCA
  // update that adds more overlap is handled the same way automatically.
  const foodNames = new Set(raw.foods.map((food) => food.name.trim().toLowerCase()));

  for (const plant of raw.plants_toxic_to_dogs) {
    const petTypes: PetToxicity[] = [{ petTypeId: 'dog', severity: 'unknown' }];
    for (const other of plant.also_toxic_to ?? []) {
      const petTypeId = ALSO_TOXIC_TO_PET_TYPE_ID[other];
      if (petTypeId && !petTypes.some((p) => p.petTypeId === petTypeId)) {
        petTypes.push({ petTypeId, severity: 'unknown' });
      }
    }

    const thingTypeId = foodNames.has(plant.name.trim().toLowerCase()) ? 'food' : 'plant';

    things.push(
      stamp({
        id: stableId(thingTypeId, plant.name),
        name: plant.name,
        otherNames: plant.other_common_names ?? [],
        thingTypeId,
        petTypes,
        details: {
          scientificName: plant.scientific_name,
          family: plant.family,
          toxicPrinciples: plant.toxic_principles,
          clinicalSigns: plant.clinical_signs,
        },
        source: raw.metadata.plant_source,
        sourceUrl: plant.aspca_url,
        verified: true,
        createdAt: '',
        updatedAt: '',
      }),
    );
  }

  for (const food of raw.foods) {
    things.push(
      stamp({
        id: stableId('food', food.name),
        name: food.name,
        otherNames: [],
        thingTypeId: 'food',
        petTypes: [{ petTypeId: 'dog', severity: normalizeSeverity(food.severity) }],
        details: { rawSeverity: food.severity, ...food },
        source: raw.metadata.food_medication_sources,
        verified: true,
        createdAt: '',
        updatedAt: '',
      }),
    );
  }

  for (const medication of raw.medications) {
    things.push(
      stamp({
        id: stableId('medication', medication.name),
        name: medication.name,
        otherNames: [],
        thingTypeId: 'medication',
        petTypes: [{ petTypeId: 'dog', severity: normalizeSeverity(medication.severity) }],
        details: { rawSeverity: medication.severity, ...medication },
        source: raw.metadata.food_medication_sources,
        verified: true,
        createdAt: '',
        updatedAt: '',
      }),
    );
  }

  return things;
}

export interface CuratedHazardsDataset {
  metadata: {
    compiled_by: string;
  };
  entries: CuratedHazardEntry[];
}

interface CuratedHazardEntry {
  name: string;
  thingType: 'product' | 'activity' | 'object';
  petTypes: string[];
  severity: Severity;
  hazard: string;
  notes?: string;
  source: string;
  sourceUrl: string;
  /** Applied uniformly across every petType above — omit to apply to the whole species. */
  breedTraits?: BreedTrait[];
  /**
   * Short search aliases. Fuse's threshold here is tuned tight for short
   * plant/food names (see search.service.ts) — a long descriptive `name`
   * needs its likely short search terms listed explicitly, or they won't
   * score well enough to surface at all.
   */
  otherNames?: string[];
}

export function transformCuratedHazards(raw: CuratedHazardsDataset): Thing[] {
  return raw.entries.map((entry) =>
    stamp({
      id: stableId(entry.thingType, entry.name),
      name: entry.name,
      otherNames: entry.otherNames ?? [],
      thingTypeId: entry.thingType,
      petTypes: entry.petTypes.map((petTypeId) => ({
        petTypeId,
        severity: entry.severity,
        ...(entry.breedTraits ? { breedTraits: entry.breedTraits } : {}),
      })),
      details: { hazard: entry.hazard, notes: entry.notes },
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      verified: true,
      createdAt: '',
      updatedAt: '',
    }),
  );
}

export interface VetmedsToxinsDataset {
  entries: VetmedsToxinEntry[];
}

export interface VetmedsToxinEntry {
  name: string;
  thingTypeId: string;
  petTypes: PetToxicity[];
  details: { category: string; clinicalSigns?: string; toxicDoseSummary?: string };
  source: string;
  sourceUrl: string;
}

/**
 * Kept separate from transformCuratedHazards rather than widening its
 * CuratedHazardEntry union — vetmeds.org entries carry a richer, differently-
 * shaped details object (clinicalSigns/toxicDoseSummary/category, not a
 * freeform hazard/notes pair), and this way existing working code stays
 * untouched. See data/seed/src/scrape-vetmeds.ts + docs/data-sourcing.md
 * for how this dataset is produced (script-assisted, human-reviewed).
 */
export function transformVetmedsToxins(raw: VetmedsToxinsDataset): Thing[] {
  return raw.entries.map((entry) =>
    stamp({
      id: stableId(entry.thingTypeId, entry.name),
      name: entry.name,
      otherNames: [],
      thingTypeId: entry.thingTypeId,
      petTypes: entry.petTypes,
      details: entry.details,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      verified: true,
      createdAt: '',
      updatedAt: '',
    }),
  );
}

export interface DogBreedsDataset {
  breeds: RawBreed[];
}

interface RawBreed {
  id: string;
  name: string;
  petTypeId: string;
  traits: BreedTrait[];
}

/**
 * Reference data, not user-contributed — see data/seed/source/dog-breeds.json
 * and docs/data-sourcing.md for the AKC roster + per-trait veterinary
 * citations this was compiled from.
 */
export function transformDogBreeds(raw: DogBreedsDataset): Breed[] {
  return raw.breeds.map((breed) =>
    stamp({
      id: breed.id,
      name: breed.name,
      petTypeId: breed.petTypeId,
      traits: breed.traits,
      createdAt: '',
      updatedAt: '',
    }),
  );
}
