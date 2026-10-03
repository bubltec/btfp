import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONTENT_TABLE_NAME } from '../dynamo.js';
import { normalizeTrendTerm } from '../trends/parse.js';
import type { MemoryStore, ResearchOutcome } from './types.js';

/** Marker outcomes that mean the term was closed without research, so there is nothing to recall. */
const NOT_RESEARCHED = new Set(['triaged_out', 'in_catalog', 'duplicate']);
const RESEARCHED: ResearchOutcome[] = ['filed', 'not_hazard', 'unusable', 'no_hits'];

/**
 * One-off: gives memory a record for every topic researched before records were written per
 * topic, from the `SCRAPERTREND#` markers. Without it, memory knows nothing about earlier
 * research and cannot spot a new name for an old topic. Safe to run again: a term memory
 * already holds is left alone.
 */
export async function backfillMemory(
  db: DynamoDBDocumentClient,
  memory: MemoryStore,
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await db.send(
      new ScanCommand({
        TableName: CONTENT_TABLE_NAME,
        FilterExpression: 'SK = :meta AND begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':meta': 'META', ':prefix': 'SCRAPERTREND#' },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const term = typeof item.topic === 'string' ? item.topic : undefined;
      if (!term || NOT_RESEARCHED.has(String(item.outcome))) {
        skipped += 1;
        continue;
      }
      const [closest] = await memory.recall(term, 1);
      if (closest && normalizeTrendTerm(closest.term) === normalizeTrendTerm(term)) {
        skipped += 1;
        continue;
      }
      const outcome = RESEARCHED.find((known) => known === item.outcome) ?? 'unknown';
      await memory.remember({
        term,
        outcome,
        summary: 'Researched before memory kept one record per topic; outcome details not kept.',
      });
      written += 1;
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return { written, skipped };
}
