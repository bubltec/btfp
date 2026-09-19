import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONTENT_TABLE_NAME } from './dynamo.js';
import { normalizeTrendTerm } from './trends/parse.js';

/** PK: SCRAPERTREND#{normalizedTerm}, SK: META — exact-term skip, no GSI needed. */
export async function isTopicProcessed(
  db: DynamoDBDocumentClient,
  topic: string,
): Promise<boolean> {
  const result = await db.send(
    new GetCommand({
      TableName: CONTENT_TABLE_NAME,
      Key: { PK: topicKey(topic), SK: 'META' },
    }),
  );
  return Boolean(result.Item);
}

/**
 * Conditional put so a concurrent/retried run does not double-mark the same
 * term — ConditionalCheckFailedException just means someone else won.
 */
export async function markTopicProcessed(db: DynamoDBDocumentClient, topic: string): Promise<void> {
  try {
    await db.send(
      new PutCommand({
        TableName: CONTENT_TABLE_NAME,
        Item: {
          PK: topicKey(topic),
          SK: 'META',
          topic,
          processedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'ConditionalCheckFailedException') throw err;
  }
}

export function topicKey(topic: string): string {
  return `SCRAPERTREND#${normalizeTrendTerm(topic)}`;
}
