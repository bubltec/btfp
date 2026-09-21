import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isReviewableContribution, type Contribution } from '@btfp/shared-types';

type Row = Contribution & { PK: string; SK: string };

export const CLEANUP_REVIEWER_ID = 'system:cleanup';
export const CLEANUP_NOTE =
  'Auto-rejected: no name or type, or scraped from Google Trends page chrome.';

/**
 * Google Trends page chrome the scraper once mistook for trending topics (its link fallback
 * scraped the footer). Anything researched from one of these is noise, even when the search
 * happened to turn up a plausible-looking hazard.
 */
const PAGE_CHROME_TERMS = new Set([
  'terms',
  'send feedback',
  'privacy',
  'about',
  'sign in',
  'help',
]);

function fromPageChrome(row: Row): boolean {
  const term = (row.payload?.details as Record<string, unknown> | undefined)?.trendTerm;
  return (
    row.contributorId === 'system:agentcore-scraper' &&
    typeof term === 'string' &&
    PAGE_CHROME_TERMS.has(term.trim().toLowerCase())
  );
}

/** Pending rows a moderator can never usefully act on: no payload, no name/type, or scraped from page chrome. */
export function selectUnreviewable(rows: Row[]): Row[] {
  return rows.filter(
    (row) =>
      !row.payload ||
      typeof row.payload !== 'object' ||
      !isReviewableContribution(row) ||
      fromPageChrome(row),
  );
}

async function listPendingRows(db: DynamoDBDocumentClient, table: string): Promise<Row[]> {
  const rows: Row[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': 'STATUS#pending' },
        ExclusiveStartKey: lastKey,
      }),
    );
    rows.push(...((result.Items ?? []) as Row[]));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return rows;
}

/** Marks unreviewable pending rows rejected (same shape as the BFF's reject). Dry run unless `apply`. */
export async function rejectUnreviewable(
  db: DynamoDBDocumentClient,
  table: string,
  opts: { apply: boolean; now?: string },
): Promise<{ found: Row[]; rejected: number }> {
  const found = selectUnreviewable(await listPendingRows(db, table));
  if (!opts.apply) return { found, rejected: 0 };
  const now = opts.now ?? new Date().toISOString();
  for (const row of found) {
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: row.PK, SK: row.SK },
        UpdateExpression:
          'SET #status = :rejected, reviewedAt = :now, reviewerId = :reviewer, reviewNotes = :notes REMOVE GSI2PK, GSI2SK',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':rejected': 'rejected',
          ':now': now,
          ':reviewer': CLEANUP_REVIEWER_ID,
          ':notes': CLEANUP_NOTE,
        },
      }),
    );
  }
  return { found, rejected: found.length };
}
