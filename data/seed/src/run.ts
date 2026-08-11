import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Breed, PetType, Thing, ThingType } from '@btfp/shared-types';
import {
  PET_TYPES,
  THING_TYPES,
  transformDataset,
  transformCuratedHazards,
  transformVetmedsToxins,
  transformDogBreeds,
  type RawDataset,
  type CuratedHazardsDataset,
  type VetmedsToxinsDataset,
  type DogBreedsDataset,
} from './transform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_TABLE_NAME = process.env.CONTENT_TABLE_NAME ?? 'btfp-dev-content';
const BATCH_SIZE = 25;

function endpointFromArgs(): string | undefined {
  const flagIndex = process.argv.indexOf('--endpoint');
  if (flagIndex !== -1) return process.argv[flagIndex + 1];
  return process.env.DYNAMODB_ENDPOINT;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function batchWrite(db: DynamoDBDocumentClient, items: Record<string, unknown>[]) {
  for (const batch of chunk(items, BATCH_SIZE)) {
    await db.send(
      new BatchWriteCommand({
        RequestItems: {
          [CONTENT_TABLE_NAME]: batch.map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
  }
}

const petTypeItem = (petType: PetType) => ({ ...petType, PK: `PETTYPE#${petType.id}`, SK: 'META' });
const breedItem = (breed: Breed) => ({
  ...breed,
  PK: `BREED#${breed.id}`,
  SK: 'META',
  GSI1PK: `PETTYPE#${breed.petTypeId}`,
  GSI1SK: `BREED#${breed.name}`,
});
const thingTypeItem = (thingType: ThingType) => ({
  ...thingType,
  PK: `THINGTYPE#${thingType.id}`,
  SK: 'META',
});
const thingItem = (thing: Thing) => ({
  ...thing,
  PK: `THING#${thing.id}`,
  SK: 'META',
  GSI1PK: `THINGTYPE#${thing.thingTypeId}`,
  GSI1SK: `THING#${thing.name}`,
});

async function main() {
  const endpoint = endpointFromArgs();
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });
  const db = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  // Gitignored (ASPCA-licensed content, not committed — see
  // docs/data-sourcing.md) — optional so CI, which only has the committed
  // datasets below, can still seed those instead of crashing outright.
  const things: Thing[] = [];
  const datasetPath = path.join(__dirname, '../source/dog-toxicity-dataset.json');
  try {
    const raw = JSON.parse(await readFile(datasetPath, 'utf-8')) as RawDataset;
    things.push(...transformDataset(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const hazardsPath = path.join(__dirname, '../source/product-activity-hazards.json');
  const rawHazards = JSON.parse(await readFile(hazardsPath, 'utf-8')) as CuratedHazardsDataset;
  things.push(...transformCuratedHazards(rawHazards));

  // Gitignored, human-reviewed output of scrape-vetmeds.ts (see
  // docs/data-sourcing.md) — optional so a fresh contributor without this
  // file can still run seed:local using just the datasets above.
  const vetmedsPath = path.join(__dirname, '../source/vetmeds-toxins.json');
  try {
    const rawVetmeds = JSON.parse(await readFile(vetmedsPath, 'utf-8')) as VetmedsToxinsDataset;
    things.push(...transformVetmedsToxins(rawVetmeds));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const breedsPath = path.join(__dirname, '../source/dog-breeds.json');
  const rawBreeds = JSON.parse(await readFile(breedsPath, 'utf-8')) as DogBreedsDataset;
  const breeds = transformDogBreeds(rawBreeds);

  console.log(
    `Seeding ${PET_TYPES.length} pet types, ${THING_TYPES.length} thing types, ${breeds.length} breeds, ` +
      `${things.length} things into ${CONTENT_TABLE_NAME}${endpoint ? ` at ${endpoint}` : ''}`,
  );

  await batchWrite(db, PET_TYPES.map(petTypeItem));
  await batchWrite(db, THING_TYPES.map(thingTypeItem));
  await batchWrite(db, breeds.map(breedItem));
  await batchWrite(db, things.map(thingItem));

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
