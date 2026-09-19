import { describe, expect, it } from 'vitest';
import { mockAws } from './test-utils.js';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { isTopicProcessed, markTopicProcessed, topicKey } from './seen.js';

function client() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

describe('seen', () => {
  it('keys on the normalized topic', () => {
    expect(topicKey('  Xylitol  Gum ')).toBe('SCRAPERTREND#xylitol gum');
  });

  it('reports processed when the marker item exists', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({ Item: { PK: 'SCRAPERTREND#xylitol', SK: 'META' } });
    expect(await isTopicProcessed(client(), 'xylitol')).toBe(true);
  });

  it('writes a conditional marker on the expected key', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    await markTopicProcessed(client(), 'Xylitol');
    const input = db.commandCalls(PutCommand)[0]?.args[0].input;
    expect(input?.Item).toMatchObject({ PK: 'SCRAPERTREND#xylitol', SK: 'META', topic: 'Xylitol' });
    expect(input?.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('swallows a ConditionalCheckFailedException', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    const err = new Error('conditional failed');
    err.name = 'ConditionalCheckFailedException';
    db.on(PutCommand).rejects(err);
    await expect(markTopicProcessed(client(), 'xylitol')).resolves.toBeUndefined();
  });
});
