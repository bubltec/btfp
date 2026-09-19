import { describe, expect, it } from 'vitest';
import {
  transformDataset,
  transformVetmedsToxins,
  type RawDataset,
  type VetmedsToxinsDataset,
} from './transform.js';

describe('transformDataset', () => {
  const baseRaw: RawDataset = {
    metadata: { plant_source: 'ASPCA plants', food_medication_sources: 'ASPCA foods' },
    plants_toxic_to_dogs: [
      {
        name: 'Garlic',
        other_common_names: [],
        scientific_name: 'Allium sativum',
        family: 'Liliaceae',
        aspca_url: 'https://example.com/garlic',
        toxic_principles: 'N-propyl disulfide',
        clinical_signs: 'hemolytic anemia',
        also_toxic_to: ['Cats', 'Horses'],
      },
      {
        name: 'Sago Palm',
        other_common_names: [],
        scientific_name: 'Cycas revoluta',
        family: 'Cycadaceae',
        aspca_url: 'https://example.com/sago-palm',
        toxic_principles: 'cycasin',
        clinical_signs: 'liver failure',
        also_toxic_to: ['Cats'],
      },
    ],
    plants_non_toxic_to_dogs: [],
    foods: [{ name: 'Garlic', severity: 'severe' }],
    medications: [],
  } as unknown as RawDataset;

  it('routes a plant-list entry into thingTypeId food when it also appears on the foods list, so it merges instead of duplicating', () => {
    const things = transformDataset(baseRaw);
    const garlicEntries = things.filter((t) => t.name === 'Garlic');

    // One from plants_toxic_to_dogs (routed to 'food'), one from foods.
    expect(garlicEntries).toHaveLength(2);
    expect(garlicEntries.every((t) => t.thingTypeId === 'food')).toBe(true);
    // Same thingTypeId + name -> same stable id -> dedupeThings will merge them.
    expect(garlicEntries[0]?.id).toBe(garlicEntries[1]?.id);
  });

  it('leaves a plant-list entry as thingTypeId plant when it has no foods-list counterpart', () => {
    const things = transformDataset(baseRaw);
    const sagoPalm = things.find((t) => t.name === 'Sago Palm');

    expect(sagoPalm?.thingTypeId).toBe('plant');
  });

  it("still carries the plant listing's also_toxic_to pet types even when routed to food", () => {
    const things = transformDataset(baseRaw);
    const routedGarlic = things.find((t) => t.name === 'Garlic' && t.details.toxicPrinciples);

    expect(routedGarlic?.petTypes.map((p) => p.petTypeId).sort()).toEqual(['cat', 'dog', 'horse']);
  });
});

describe('transformVetmedsToxins', () => {
  const raw: VetmedsToxinsDataset = {
    entries: [
      {
        name: 'Chocolate',
        thingTypeId: 'food',
        petTypes: [
          { petTypeId: 'dog', severity: 'moderate' },
          { petTypeId: 'cat', severity: 'moderate' },
        ],
        details: {
          category: 'Food',
          clinicalSigns: 'vomiting, diarrhea, panting, tremors, seizures.',
          toxicDoseSummary: 'In dogs, 250 mg/kg can be toxic.',
        },
        source: 'American College of Veterinary Pharmacists — Pet Poison Control',
        sourceUrl: 'https://vetmeds.org/pet-poison-control-list/chocolate/',
      },
    ],
  };

  it('produces a Thing with a stable id derived from thingTypeId + name', () => {
    const [thing] = transformVetmedsToxins(raw);

    expect(thing?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(thing?.name).toBe('Chocolate');
    expect(thing?.thingTypeId).toBe('food');
  });

  it('is deterministic — the same input always produces the same id', () => {
    const [first] = transformVetmedsToxins(raw);
    const [second] = transformVetmedsToxins(raw);

    expect(first?.id).toBe(second?.id);
  });

  it('always marks entries verified, carries per-entry source/sourceUrl, and preserves petTypes', () => {
    const [thing] = transformVetmedsToxins(raw);

    expect(thing?.verified).toBe(true);
    expect(thing?.source).toBe('American College of Veterinary Pharmacists — Pet Poison Control');
    expect(thing?.sourceUrl).toBe('https://vetmeds.org/pet-poison-control-list/chocolate/');
    expect(thing?.petTypes).toEqual([
      { petTypeId: 'dog', severity: 'moderate' },
      { petTypeId: 'cat', severity: 'moderate' },
    ]);
  });

  it('carries clinicalSigns/toxicDoseSummary/category into details', () => {
    const [thing] = transformVetmedsToxins(raw);

    expect(thing?.details).toEqual({
      category: 'Food',
      clinicalSigns: 'vomiting, diarrhea, panting, tremors, seizures.',
      toxicDoseSummary: 'In dogs, 250 mg/kg can be toxic.',
    });
  });

  it('produces one Thing per entry', () => {
    const twoEntries: VetmedsToxinsDataset = {
      entries: [raw.entries[0]!, { ...raw.entries[0]!, name: 'Xylitol' }],
    };

    const things = transformVetmedsToxins(twoEntries);

    expect(things).toHaveLength(2);
    expect(things.map((t) => t.name)).toEqual(['Chocolate', 'Xylitol']);
    // Different names -> different stable ids, even with the same thingTypeId.
    expect(things[0]?.id).not.toBe(things[1]?.id);
  });
});
