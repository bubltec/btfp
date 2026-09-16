import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  dedupeThings,
  findDuplicateThing,
  mergeThings,
  normalizeScientificName,
  normalizeThingName,
  thingsMatch,
  type Thing,
} from '@btfp/shared-types';
import {
  transformCuratedHazards,
  transformDataset,
  transformVetmedsToxins,
  type CuratedHazardsDataset,
  type RawDataset,
  type VetmedsToxinsDataset,
} from './transform.js';

const now = '2026-01-01T00:00:00.000Z';

function thing(overrides: Partial<Thing> & Pick<Thing, 'id' | 'name' | 'thingTypeId'>): Thing {
  return {
    otherNames: [],
    petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
    details: {},
    source: 'test',
    verified: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('normalizeThingName', () => {
  it('collapses case, punctuation, and whitespace', () => {
    expect(normalizeThingName('Macadamia Nuts')).toBe(normalizeThingName('Macadamia nuts'));
    expect(normalizeThingName("Devil's Ivy")).toBe(normalizeThingName('Devils Ivy'));
  });
});

describe('normalizeScientificName', () => {
  it('drops spp/sp noise so close listings share a key', () => {
    expect(normalizeScientificName('Narcissus spp')).toBe(
      normalizeScientificName('Narcissus spp.'),
    );
    expect(normalizeScientificName('Clematis sp.')).toBe(normalizeScientificName('Clematis spp.'));
  });
});

describe('dedupeThings', () => {
  it('returns a copy unchanged when every row is already unique', () => {
    const input = [
      thing({ id: 'a', name: 'Socks', thingTypeId: 'object' }),
      thing({ id: 'b', name: 'Chocolate / cocoa', thingTypeId: 'food' }),
    ];
    const { things, discarded } = dedupeThings(input);
    expect(discarded).toHaveLength(0);
    expect(things.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('merges the same species listed under every common name', () => {
    const { things, discarded } = dedupeThings([
      thing({
        id: 'calla',
        name: 'Calla Lily',
        thingTypeId: 'plant',
        otherNames: ['Pig Lily', 'Arum Lily'],
        details: { scientificName: 'Zantedeschia aethiopica' },
      }),
      thing({
        id: 'pig',
        name: 'Pig Lily',
        thingTypeId: 'plant',
        otherNames: ['Calla Lily'],
        details: { scientificName: 'Zantedeschia aethiopica' },
      }),
      thing({
        id: 'arum',
        name: 'Arum Lily',
        thingTypeId: 'plant',
        otherNames: ['Calla Lily'],
        details: { scientificName: 'Zantedeschia aethiopica' },
      }),
    ]);

    expect(things).toHaveLength(1);
    expect(discarded).toHaveLength(2);
    expect(things[0]?.details.scientificName).toBe('Zantedeschia aethiopica');
    const names = new Set([things[0]!.name, ...things[0]!.otherNames].map(normalizeThingName));
    expect(names).toEqual(new Set(['calla lily', 'pig lily', 'arum lily']));
  });

  it('does not merge different species that share a common-name suffix', () => {
    const { things, discarded } = dedupeThings([
      thing({
        id: 'pride',
        name: 'Barbados Pride',
        thingTypeId: 'plant',
        details: { scientificName: 'Caesalpinia pulcherrima' },
      }),
      thing({
        id: 'pride-2',
        name: 'Barbados Pride 2',
        thingTypeId: 'plant',
        details: { scientificName: 'Poinciana gilliesii' },
      }),
    ]);

    expect(things).toHaveLength(2);
    expect(discarded).toHaveLength(0);
  });

  it('does not merge Fetter Bush and Fetterbush (different genera)', () => {
    const { things } = dedupeThings([
      thing({
        id: 'bush',
        name: 'Fetter Bush',
        thingTypeId: 'plant',
        details: { scientificName: 'Leucothoe spp.' },
      }),
      thing({
        id: 'fetterbush',
        name: 'Fetterbush',
        thingTypeId: 'plant',
        details: { scientificName: 'Lyonia spp.' },
      }),
    ]);

    expect(things).toHaveLength(2);
  });

  it('merges case/punctuation variants of the same food', () => {
    const { things, discarded } = dedupeThings([
      thing({ id: 'aspca', name: 'Macadamia nuts', thingTypeId: 'food' }),
      thing({ id: 'vetmeds', name: 'Macadamia Nuts', thingTypeId: 'food' }),
    ]);

    expect(things).toHaveLength(1);
    expect(discarded).toHaveLength(1);
  });

  it('merges a short name onto a longer unique match (Chocolate → Chocolate / cocoa)', () => {
    const { things } = dedupeThings([
      thing({ id: 'long', name: 'Chocolate / cocoa', thingTypeId: 'food' }),
      thing({ id: 'short', name: 'Chocolate', thingTypeId: 'food' }),
    ]);

    expect(things).toHaveLength(1);
    expect(things[0]?.id).toBe('long');
    expect(things[0]?.otherNames.map(normalizeThingName)).toContain('chocolate');
  });

  it('merges daffodil/daffodils via singularization', () => {
    const { things } = dedupeThings([
      thing({
        id: 'one',
        name: 'Daffodil',
        thingTypeId: 'plant',
        details: { scientificName: 'Narcissus spp' },
      }),
      thing({ id: 'plural', name: 'Daffodils', thingTypeId: 'plant' }),
    ]);

    expect(things).toHaveLength(1);
  });

  it('attaches a unique alias match (Pothos → Golden Pothos)', () => {
    const { things } = dedupeThings([
      thing({
        id: 'golden',
        name: 'Golden Pothos',
        thingTypeId: 'plant',
        otherNames: ['Pothos', "Devil's Ivy"],
        details: { scientificName: 'Epipremnum aureum' },
      }),
      thing({ id: 'pothos', name: 'Pothos', thingTypeId: 'plant' }),
    ]);

    expect(things).toHaveLength(1);
    expect(things[0]?.id).toBe('golden');
  });

  it('leaves a conjunction that matches two existing medications alone', () => {
    const { things, discarded } = dedupeThings([
      thing({ id: 'ibu', name: 'Ibuprofen (Advil, Motrin)', thingTypeId: 'medication' }),
      thing({ id: 'nap', name: 'Naproxen (Aleve)', thingTypeId: 'medication' }),
      thing({ id: 'both', name: 'Ibuprofen & Naproxen', thingTypeId: 'medication' }),
    ]);

    expect(things).toHaveLength(3);
    expect(discarded).toHaveLength(0);
  });

  it('does not merge across thing types', () => {
    const { things } = dedupeThings([
      thing({ id: 'food', name: 'Macadamia nuts', thingTypeId: 'food' }),
      thing({
        id: 'plant',
        name: 'Macadamia Nut',
        thingTypeId: 'plant',
        details: { scientificName: 'Macadamia integrifolia' },
      }),
    ]);

    expect(things).toHaveLength(2);
  });
});

describe('mergeThings', () => {
  it('keeps the canonical name/id and unions aliases, pet types, and details', () => {
    const merged = mergeThings(
      thing({
        id: 'canon',
        name: 'Chocolate / cocoa',
        thingTypeId: 'food',
        petTypes: [{ petTypeId: 'dog', severity: 'moderate' }],
        details: { scientificName: undefined, notes: 'theobromine' },
      }),
      thing({
        id: 'extra',
        name: 'Chocolate',
        thingTypeId: 'food',
        petTypes: [
          { petTypeId: 'dog', severity: 'severe' },
          { petTypeId: 'cat', severity: 'moderate' },
        ],
        details: { clinicalSigns: 'vomiting' },
      }),
    );

    expect(merged.id).toBe('canon');
    expect(merged.name).toBe('Chocolate / cocoa');
    expect(merged.otherNames).toContain('Chocolate');
    expect(merged.petTypes).toEqual([
      { petTypeId: 'dog', severity: 'severe' },
      { petTypeId: 'cat', severity: 'moderate' },
    ]);
    expect(merged.details).toMatchObject({ notes: 'theobromine', clinicalSigns: 'vomiting' });
  });
});

describe('findDuplicateThing', () => {
  const catalog = [
    thing({ id: 'choc', name: 'Chocolate / cocoa', thingTypeId: 'food' }),
    thing({ id: 'sock', name: 'Socks', thingTypeId: 'object' }),
  ];

  it('returns the unique match', () => {
    expect(findDuplicateThing(catalog, { name: 'Chocolate', thingTypeId: 'food' })?.id).toBe(
      'choc',
    );
  });

  it('returns undefined when nothing matches', () => {
    expect(findDuplicateThing(catalog, { name: 'Xylitol', thingTypeId: 'food' })).toBeUndefined();
  });

  it('does not match a different type', () => {
    expect(findDuplicateThing(catalog, { name: 'Socks', thingTypeId: 'food' })).toBeUndefined();
  });
});

describe('thingsMatch', () => {
  it('is false for unrelated names of the same type', () => {
    expect(
      thingsMatch(
        { name: 'Socks', thingTypeId: 'object' },
        { name: 'Underwear / elastic waistband clothing', thingTypeId: 'object' },
      ),
    ).toBe(false);
  });
});

const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../source');

describe('local seed datasets', () => {
  const toxicityPath = path.join(sourceDir, 'dog-toxicity-dataset.json');
  const vetmedsPath = path.join(sourceDir, 'vetmeds-toxins.json');
  const hazardsPath = path.join(sourceDir, 'product-activity-hazards.json');

  it.skipIf(!existsSync(toxicityPath))(
    'collapses ASPCA same-species plant listings and overlapping vetmeds rows',
    async () => {
      const things: Thing[] = [];
      things.push(
        ...transformDataset(JSON.parse(await readFile(toxicityPath, 'utf-8')) as RawDataset),
      );
      if (existsSync(vetmedsPath)) {
        things.push(
          ...transformVetmedsToxins(
            JSON.parse(await readFile(vetmedsPath, 'utf-8')) as VetmedsToxinsDataset,
          ),
        );
      }
      things.push(
        ...transformCuratedHazards(
          JSON.parse(await readFile(hazardsPath, 'utf-8')) as CuratedHazardsDataset,
        ),
      );

      const before = things.length;
      const { things: kept, discarded } = dedupeThings(things);

      expect(discarded.length).toBeGreaterThan(100);
      expect(kept.length).toBeLessThan(before);

      const sciKeys = kept
        .map((t) =>
          typeof t.details.scientificName === 'string'
            ? `${t.thingTypeId}#${normalizeScientificName(t.details.scientificName)}`
            : null,
        )
        .filter((key): key is string => Boolean(key));
      expect(new Set(sciKeys).size).toBe(sciKeys.length);

      const calla = kept.filter(
        (t) =>
          typeof t.details.scientificName === 'string' &&
          normalizeScientificName(t.details.scientificName) === 'zantedeschia aethiopica',
      );
      expect(calla).toHaveLength(1);

      const leucothoe = kept.filter(
        (t) =>
          typeof t.details.scientificName === 'string' &&
          normalizeScientificName(t.details.scientificName) === 'leucothoe',
      );
      const lyonia = kept.filter(
        (t) =>
          typeof t.details.scientificName === 'string' &&
          normalizeScientificName(t.details.scientificName) === 'lyonia',
      );
      expect(leucothoe).toHaveLength(1);
      expect(lyonia).toHaveLength(1);
      expect(leucothoe[0]?.id).not.toBe(lyonia[0]?.id);

      const chocolate = kept.filter(
        (t) => t.thingTypeId === 'food' && /chocolate/i.test(`${t.name} ${t.otherNames.join(' ')}`),
      );
      expect(chocolate).toHaveLength(1);
    },
  );
});
