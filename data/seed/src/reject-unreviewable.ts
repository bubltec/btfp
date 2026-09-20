import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isReviewableContribution, type Contribution } from '@btfp/shared-types';

type Row = Contribution & { PK: string; SK: string };

export const CLEANUP_REVIEWER_ID = 'system:cleanup';
export const CLEANUP_NOTE = 'Auto-rejected: no name or type, so it could not be reviewed.';

/** Pending rows a moderator can never act on (no payload, or no name/type). */
export function selectUnreviewable(rows: Row[]): Row[] {
  return rows.filter(
    (row) => !row.payload || typeof row.payload !== 'object' || !isReviewableContribution(row),
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
