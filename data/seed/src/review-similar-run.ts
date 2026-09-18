import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { Thing } from '@btfp/shared-types';
import {
  transformDataset,
  transformCuratedHazards,
  transformVetmedsToxins,
  type RawDataset,
  type CuratedHazardsDataset,
  type VetmedsToxinsDataset,
} from './transform.js';
import { reviewCatalog } from './review-similar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Human-review aid, not a seeding step: scans the local seed source files for
 * combo-style names ("Onions, garlic, leeks, chives, shallots (Allium spp.)")
 * and asks Bedrock whether each should be split into individual entries and
 * which existing rows overlap. Prints a report — nothing here writes to the
 * source files or Dynamo; a human applies whatever split/merge makes sense
 * (see docs/data-sourcing.md, "Bedrock-assisted similarity review").
 *
 * Run with: pnpm --filter @btfp/seed review:similar
 */
async function main() {
  const things: Thing[] = [];

  const datasetPath = path.join(__dirname, '../source/dog-toxicity-dataset.json');
  try {
    const raw = JSON.parse(await readFile(datasetPath, 'utf-8')) as RawDataset;
    things.push(...transformDataset(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const hazardsPath = path.join(__dirname, '../source/product-activity-hazards.json');
  try {
    const rawHazards = JSON.parse(await readFile(hazardsPath, 'utf-8')) as CuratedHazardsDataset;
    things.push(...transformCuratedHazards(rawHazards));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const vetmedsPath = path.join(__dirname, '../source/vetmeds-toxins.json');
  try {
    const rawVetmeds = JSON.parse(await readFile(vetmedsPath, 'utf-8')) as VetmedsToxinsDataset;
    things.push(...transformVetmedsToxins(rawVetmeds));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (things.length === 0) {
    console.log('No local seed source files found — nothing to review.');
    return;
  }

  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const modelId = process.env.BEDROCK_INFERENCE_PROFILE_ID ?? DEFAULT_MODEL_ID;

  console.log(`Scanning ${things.length} things for combo-style names...`);
  const flagged = await reviewCatalog(client, modelId, things);

  if (flagged.length === 0) {
    console.log('No combo entries flagged.');
    return;
  }

  console.log(
    `\n${flagged.length} entr${flagged.length === 1 ? 'y' : 'ies'} flagged for review:\n`,
  );
  for (const { thing, review } of flagged) {
    console.log(`— "${thing.name}" (${thing.thingTypeId}, id ${thing.id})`);
    console.log(`  Reasoning: ${review.reasoning}`);
    console.log(
      `  Proposed split: ${review.members.map((m) => m.name + (m.scientificName ? ` (${m.scientificName})` : '')).join(', ')}`,
    );
    if (review.overlapsExisting.length > 0) {
      console.log(`  Overlaps existing entries: ${review.overlapsExisting.join(', ')}`);
    }
    console.log('');
  }
  console.log(
    'Nothing was changed automatically — review the entries above and edit the source JSON ' +
      'files by hand (see docs/data-sourcing.md).',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
