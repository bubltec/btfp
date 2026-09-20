import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { rejectUnreviewable } from './reject-unreviewable.js';

/**
 * Rejects pending contributions with no name or type (they render as "(no name)" and can't be
 * approved). Dry run by default; pass --apply to write.
 *
 * Run with: CONTENT_TABLE_NAME=btfp-dev-content pnpm --filter @btfp/seed reject:unreviewable [--apply]
 */
async function main() {
  const table = process.env.CONTENT_TABLE_NAME ?? 'btfp-dev-content';
  const apply = process.argv.includes('--apply');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const { found, rejected } = await rejectUnreviewable(db, table, { apply });
  for (const row of found) {
    console.log(
      `${row.PK} ${row.SK} contributor=${row.contributorId} payload=${JSON.stringify(row.payload ?? null)}`,
    );
  }
  console.log(
    apply
      ? `Rejected ${rejected} unreviewable pending row(s) in ${table}.`
      : `Dry run: ${found.length} unreviewable pending row(s) in ${table}. Re-run with --apply to reject them.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
