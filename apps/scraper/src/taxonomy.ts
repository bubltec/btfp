import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ThingIdentity } from '@btfp/shared-types';
import { CONTENT_TABLE_NAME } from './dynamo.js';
import type { Taxonomy } from './extract/types.js';

export interface CatalogThing extends ThingIdentity {
  id: string;
}

async function scanIds(db: DynamoDBDocumentClient, prefix: string): Promise<string[]> {
  const result = await db.send(
    new ScanCommand({
      TableName: CONTENT_TABLE_NAME,
      FilterExpression: 'SK = :meta AND begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':meta': 'META', ':prefix': prefix },
    }),
  );
  return (result.Items ?? [])
    .map((item) => (typeof item.id === 'string' ? item.id : undefined))
    .filter((id): id is string => Boolean(id));
}

/**
 * Pet/thing types are runtime DB rows in this schema, not a fixed enum, so
 * the Bedrock tool's enum has to come from a live scan rather than being
 * hardcoded. Degrades to a single 'unknown' fallback if a scan comes back
 * empty (shouldn't happen against a seeded table, but shouldn't crash the
 * run either).
 */
export async function loadTaxonomy(db: DynamoDBDocumentClient): Promise<Taxonomy> {
  const [thingTypeIds, petTypeIds] = await Promise.all([
    scanIds(db, 'THINGTYPE#'),
    scanIds(db, 'PETTYPE#'),
  ]);

  return {
    thingTypeIds: thingTypeIds.length > 0 ? thingTypeIds : ['unknown'],
    petTypeIds: petTypeIds.length > 0 ? petTypeIds : ['unknown'],
  };
}

/** Live Thing rows, used to attach scraper candidates to an existing entry instead of proposing a duplicate. */
export async function loadThingCatalog(db: DynamoDBDocumentClient): Promise<CatalogThing[]> {
  const items: CatalogThing[] = [];
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
      if (
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.thingTypeId !== 'string'
      ) {
        continue;
      }
      items.push({
        id: item.id,
        name: item.name,
        thingTypeId: item.thingTypeId,
        otherNames: Array.isArray(item.otherNames)
          ? item.otherNames.filter((name): name is string => typeof name === 'string')
          : [],
        details:
          item.details && typeof item.details === 'object'
            ? (item.details as Record<string, unknown>)
            : {},
      });
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return items;
}
