import { describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockAws } from './test-utils.js';
import { rejectUnreviewable, selectUnreviewable } from './reject-unreviewable.js';

const base = { contributorId: 'u', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' };
const items = [
  { ...base, id: '1', PK: 'THING#1', SK: 'a', payload: { name: 'Grapes', thingTypeId: 'food' } },
  { ...base, id: '2', PK: 'THING#2', SK: 'b', payload: { source: 'agentcore' } },
  { ...base, id: '3', PK: 'THING#3', SK: 'c' },
  {
    ...base,
    id: '4',
    PK: 'THING#4',
    SK: 'd',
    contributorId: 'system:agentcore-scraper',
    payload: { name: 'Chocolate', thingTypeId: 'food', details: { trendTerm: 'Help' } },
  },
  {
    ...base,
    id: '5',
    PK: 'THING#5',
    SK: 'e',
    contributorId: 'system:agentcore-scraper',
    payload: { name: 'Xylitol', thingTypeId: 'food', details: { trendTerm: 'xylitol gum' } },
  },
];

describe('rejectUnreviewable', () => {
  it('selects only rows without a name and type', () => {
    expect(selectUnreviewable(items as never).map((r) => r.SK)).toEqual(['b', 'c', 'd']);
  });

  it('is a dry run unless apply is set', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(QueryCommand).resolves({ Items: items });
    const result = await rejectUnreviewable(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      't',
      {
        apply: false,
      },
    );
    expect(result.found).toHaveLength(3);
    expect(db.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('rejects them and drops them from the pending index when applied', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(QueryCommand).resolves({ Items: items });
    db.on(UpdateCommand).resolves({});
    const result = await rejectUnreviewable(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      't',
      {
        apply: true,
        now: '2026-02-01T00:00:00.000Z',
      },
    );
    expect(result.rejected).toBe(3);
    const calls = db
      .commandCalls(UpdateCommand)
      .map((c: { args: [{ input: Record<string, any> }] }) => c.args[0].input);
    expect(calls.map((c: any) => c.Key.SK)).toEqual(['b', 'c', 'd']);
    expect(calls[0]?.UpdateExpression).toContain('REMOVE GSI2PK, GSI2SK');
    expect(calls[0]?.ExpressionAttributeValues[':rejected']).toBe('rejected');
  });
});
