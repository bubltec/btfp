import { randomUUID } from 'node:crypto';
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  findDuplicateThing,
  mergeThingPayload,
  planContributionAttach,
  type Contribution,
} from '@btfp/shared-types';
import { CONTENT_TABLE_NAME } from './dynamo.js';
import type { CandidateDocument } from './search/types.js';
import type { ExtractionResult } from './extract/types.js';
import type { CatalogThing } from './taxonomy.js';

/** Sentinel contributorId — never resolves to a real user. Verified safe
 * against contributions.service.ts's approve()'s `contributor?.professional`
 * optional chain, which degrades gracefully for an unresolvable id. */
export const SCRAPER_CONTRIBUTOR_ID = 'system:agentcore-scraper';

/** Worth a moderator's time: a name and a type, and sources that agree well enough to trust. */
export function isFileableExtraction(
  extraction: ExtractionResult,
): extraction is ExtractionResult & { thingName: string; thingTypeId: string } {
  return Boolean(
    extraction.thingName?.trim() &&
    extraction.thingTypeId?.trim() &&
    extraction.confidence !== 'low',
  );
}

async function listPending(db: DynamoDBDocumentClient): Promise<Contribution[]> {
  const items: Contribution[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await db.send(
      new QueryCommand({
        TableName: CONTENT_TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': 'STATUS#pending' },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((result?.Items ?? []) as Contribution[]));
    lastKey = result?.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return items.filter((item) => item.payload && typeof item.payload === 'object');
}

/**
 * Same attach/accumulate rules as ContributionsService.propose: catalog
 * match becomes an edit; an already-queued identity folds new facts into
 * that pending row instead of another moderation card.
 */
export async function writeContribution(
  db: DynamoDBDocumentClient,
  document: CandidateDocument,
  extraction: ExtractionResult,
  catalog: CatalogThing[] = [],
): Promise<Contribution> {
  if (!isFileableExtraction(extraction)) {
    throw new Error('Refusing to file a contribution without a thing name and type');
  }
  const payload: Contribution['payload'] = {
    name: extraction.thingName,
    thingTypeId: extraction.thingTypeId,
    petTypes: extraction.petTypes ?? [],
    details: {
      summary: extraction.summary,
      trendTerm: document.topic,
      ...(extraction.confidence ? { confidence: extraction.confidence } : {}),
    },
    source: document.source,
    sourceUrl: document.sourceUrl,
  };

  const identity =
    extraction.thingName && extraction.thingTypeId
      ? { name: extraction.thingName, thingTypeId: extraction.thingTypeId }
      : undefined;
  const catalogMatch = identity ? findDuplicateThing(catalog, identity) : undefined;
  const pending = await listPending(db);
  const { pendingMatch, thingId } = identity
    ? planContributionAttach({
        payload: identity,
        catalogMatchId: catalogMatch?.id,
        pending,
      })
    : { pendingMatch: undefined, thingId: catalogMatch?.id };

  if (pendingMatch) {
    const merged = mergeThingPayload(pendingMatch.payload, payload);
    const row = pendingMatch as Contribution & { PK?: string; SK?: string };
    const pk = row.PK ?? `THING#${pendingMatch.thingId ?? pendingMatch.id}`;
    const sk = row.SK;
    if (sk) {
      const linked = thingId ?? pendingMatch.thingId;
      await db.send(
        new UpdateCommand({
          TableName: CONTENT_TABLE_NAME,
          Key: { PK: pk, SK: sk },
          UpdateExpression: linked
            ? 'SET payload = :payload, thingId = :thingId'
            : 'SET payload = :payload',
          ExpressionAttributeValues: {
            ':payload': merged,
            ...(linked ? { ':thingId': linked } : {}),
          },
        }),
      );
      return { ...pendingMatch, payload: merged, thingId: linked };
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const targetThingId = thingId ?? id;
  const contribution: Contribution = {
    id,
    thingId,
    contributorId: SCRAPER_CONTRIBUTOR_ID,
    status: 'pending',
    payload,
    createdAt: now,
  };

  await db.send(
    new PutCommand({
      TableName: CONTENT_TABLE_NAME,
      Item: {
        ...contribution,
        PK: `THING#${targetThingId}`,
        SK: `CONTRIB#${now}#${SCRAPER_CONTRIBUTOR_ID}`,
        GSI2PK: 'STATUS#pending',
        GSI2SK: `CONTRIB#${now}`,
      },
    }),
  );

  return contribution;
}
