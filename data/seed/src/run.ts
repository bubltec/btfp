import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  dedupeThings,
  type Breed,
  type PetType,
  type Thing,
  type ThingType,
} from '@btfp/shared-types';
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
export const CONTENT_TABLE_NAME = process.env.CONTENT_TABLE_NAME ?? 'btfp-dev-content';
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

const MAX_UNPROCESSED_RETRIES = 5;

/**
 * BatchWriteItem can return `UnprocessedItems` under throttling even on a
 * 200 response — it's not an error, just a partial success, and the SDK
 * does not retry those for you. Ignoring that (as this used to) silently
 * drops rows: seeding prod once wrote "345 things" per its own log line,
 * but only 338 actually landed in the table. Retries with jittered
 * backoff; throws if items are still unprocessed after all retries so a
 * partial seed fails loudly instead of quietly missing rows.
 */
async function sendBatchWithRetry(db: DynamoDBDocumentClient, requests: Record<string, unknown>[]) {
  let remaining = requests;
  for (let attempt = 0; attempt < MAX_UNPROCESSED_RETRIES && remaining.length > 0; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
    const result = await db.send(
      new BatchWriteCommand({ RequestItems: { [CONTENT_TABLE_NAME]: remaining } }),
    );
    remaining = (result.UnprocessedItems?.[CONTENT_TABLE_NAME] ?? []) as Record<string, unknown>[];
  }
  if (remaining.length > 0) {
    throw new Error(
      `${remaining.length} item(s) still unprocessed after ${MAX_UNPROCESSED_RETRIES} retries — ` +
        `seed run aborted rather than silently dropping rows.`,
    );
  }
}

export async function batchWrite(db: DynamoDBDocumentClient, items: Record<string, unknown>[]) {
  for (const batch of chunk(items, BATCH_SIZE)) {
    await sendBatchWithRetry(
      db,
      batch.map((Item) => ({ PutRequest: { Item } })),
    );
  }
}

async function batchDelete(db: DynamoDBDocumentClient, keys: { PK: string; SK: string }[]) {
  for (const batch of chunk(keys, BATCH_SIZE)) {
    await sendBatchWithRetry(
      db,
      batch.map((Key) => ({ DeleteRequest: { Key } })),
    );
  }
}

/**
 * Rows this run's `uniqueThings` no longer produce — e.g. a source item got
 * renamed or split since the last seed run — aren't caught by `discarded`
 * (that only covers duplicates collapsed *within this run*). Left alone,
 * they'd sit in the table forever alongside their replacement, which is
 * exactly the "old combo entry still shows up next to the new split ones"
 * bug this was seeding to fix. Only orphans `contributorId`-less seed rows
 * are deleted — anything that went through the contributions/approve flow
 * (new or merged into an existing seed row) has `contributorId` set and is
 * left alone even if its id happens to collide with a stable id this run
 * no longer emits.
 */
/**
 * `discarded` (from `dedupeThings`) holds the raw pre-merge rows folded into
 * a canonical entry — but stableId is a hash of thingTypeId+name, so two
 * rows for the *same* item from different sources (e.g. "Garlic" from ASPCA
 * + "Garlic" from vetmeds) legitimately share an id with the merged
 * canonical row that's kept. Deleting blindly by `thing.id` would delete
 * the just-written canonical row right back out — this silently dropped
 * exactly the multi-source-merged entries (Garlic, Onion, Chives, Grapes,
 * Raisins, Pseudoephedrine, Phenylephrine) from a real seed run. Anything
 * whose id is still in `keepIds` must be left alone.
 */
export function computeDiscardedKeys(
  discarded: Thing[],
  keepIds: Set<string>,
): { PK: string; SK: string }[] {
  return discarded
    .map((thing) => ({ PK: `THING#${thing.id}`, SK: 'META' }))
    .filter((key) => !keepIds.has(key.PK.slice('THING#'.length)));
}

export async function findOrphanedSeedThingKeys(
  db: DynamoDBDocumentClient,
  keepIds: Set<string>,
): Promise<{ PK: string; SK: string }[]> {
  const orphans: { PK: string; SK: string }[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await db.send(
      new ScanCommand({
        TableName: CONTENT_TABLE_NAME,
        FilterExpression: 'SK = :meta AND begins_with(PK, :thingPrefix)',
        ExpressionAttributeValues: { ':meta': 'META', ':thingPrefix': 'THING#' },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const pk = (item as { PK?: string }).PK;
      const id = typeof pk === 'string' ? pk.slice('THING#'.length) : undefined;
      const contributorId = (item as { contributorId?: string }).contributorId;
      if (id && !contributorId && !keepIds.has(id)) {
        orphans.push({ PK: pk!, SK: 'META' });
      }
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return orphans;
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
  let hasAspcaDataset = false;
  const datasetPath = path.join(__dirname, '../source/dog-toxicity-dataset.json');
  try {
    const raw = JSON.parse(await readFile(datasetPath, 'utf-8')) as RawDataset;
    things.push(...transformDataset(raw));
    hasAspcaDataset = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const hazardsPath = path.join(__dirname, '../source/product-activity-hazards.json');
  const rawHazards = JSON.parse(await readFile(hazardsPath, 'utf-8')) as CuratedHazardsDataset;
  things.push(...transformCuratedHazards(rawHazards));

  // Gitignored, human-reviewed output of scrape-vetmeds.ts (see
  // docs/data-sourcing.md) — optional so a fresh contributor without this
  // file can still run seed:local using just the datasets above.
  let hasVetmedsDataset = false;
  const vetmedsPath = path.join(__dirname, '../source/vetmeds-toxins.json');
  try {
    const rawVetmeds = JSON.parse(await readFile(vetmedsPath, 'utf-8')) as VetmedsToxinsDataset;
    things.push(...transformVetmedsToxins(rawVetmeds));
    hasVetmedsDataset = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const breedsPath = path.join(__dirname, '../source/dog-breeds.json');
  const rawBreeds = JSON.parse(await readFile(breedsPath, 'utf-8')) as DogBreedsDataset;
  const breeds = transformDogBreeds(rawBreeds);

  const { things: uniqueThings, discarded } = dedupeThings(things);

  console.log(
    `Seeding ${PET_TYPES.length} pet types, ${THING_TYPES.length} thing types, ${breeds.length} breeds, ` +
      `${uniqueThings.length} things` +
      (discarded.length > 0 ? ` (${discarded.length} duplicates collapsed)` : '') +
      ` into ${CONTENT_TABLE_NAME}${endpoint ? ` at ${endpoint}` : ''}`,
  );

  await batchWrite(db, PET_TYPES.map(petTypeItem));
  await batchWrite(db, THING_TYPES.map(thingTypeItem));
  await batchWrite(db, breeds.map(breedItem));
  await batchWrite(db, uniqueThings.map(thingItem));

  const keepIds = new Set(uniqueThings.map((thing) => thing.id));
  const discardedKeys = computeDiscardedKeys(discarded, keepIds);
  // Orphan reconciliation (see findOrphanedSeedThingKeys doc comment) is only
  // safe when this run's `things` reflects the *complete* intended catalog —
  // otherwise "not in this run's output" just means "this run's environment
  // doesn't have that source file," not "the source item was actually
  // renamed/removed." CI never has the two gitignored datasets, so a run
  // there only ever produces the committed curated-hazards subset; running
  // this check there deleted all ~340 ASPCA/vetmeds-sourced rows as
  // "orphans" the one time it ran, since none of them were in that run's
  // (correctly) partial output. Only run it from a full local seed that has
  // both gitignored files.
  const orphanedKeys =
    hasAspcaDataset && hasVetmedsDataset ? await findOrphanedSeedThingKeys(db, keepIds) : [];
  if (!hasAspcaDataset || !hasVetmedsDataset) {
    console.log(
      'Skipping orphaned-row reconciliation — missing ' +
        [
          !hasAspcaDataset && 'dog-toxicity-dataset.json',
          !hasVetmedsDataset && 'vetmeds-toxins.json',
        ]
          .filter(Boolean)
          .join(' and ') +
        ", so this run only has a partial catalog and can't tell a genuinely renamed/removed " +
        'item apart from one this environment just never loads.',
    );
  }
  const deleteKeys = [
    ...discardedKeys,
    // discarded rows already covered above; avoid double-listing the same PK
    ...orphanedKeys.filter((key) => !discardedKeys.some((d) => d.PK === key.PK)),
  ];
  if (deleteKeys.length > 0) {
    console.log(
      `Deleting ${discardedKeys.length} duplicates collapsed this run + ` +
        `${deleteKeys.length - discardedKeys.length} orphaned rows from prior runs ` +
        `(renamed/split/removed source items) from ${CONTENT_TABLE_NAME}`,
    );
    await batchDelete(db, deleteKeys);
  }

  console.log('Done.');
}

// Guard so importing this module's exports (findOrphanedSeedThingKeys,
// CONTENT_TABLE_NAME) from a test doesn't also fire off a real seed run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
