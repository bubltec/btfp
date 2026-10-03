import { describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockAws } from '../test-utils.js';
import { backfillMemory } from './backfill.js';
import type { MemoryStore } from './types.js';

describe('backfillMemory', () => {
  it('writes a record for each researched marker memory does not hold yet', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(ScanCommand)
      .resolvesOnce({
        Items: [
          { PK: 'SCRAPERTREND#xylitol', topic: 'Xylitol' },
          { PK: 'SCRAPERTREND#nfl scores', topic: 'nfl scores', outcome: 'triaged_out' },
        ],
        LastEvaluatedKey: { PK: 'SCRAPERTREND#nfl scores', SK: 'META' },
      })
      .resolves({
        Items: [
          { PK: 'SCRAPERTREND#sago palm', topic: 'Sago Palm', outcome: 'filed' },
          { PK: 'SCRAPERTREND#oleander', topic: 'oleander', outcome: 'not_hazard' },
          { PK: 'SCRAPERTREND#broken' },
        ],
      });
    const remember = vi.fn<MemoryStore['remember']>(async () => undefined);
    const memory: MemoryStore = {
      // Memory already has sago palm; "oleander" only recalls something else.
      recall: async (query) =>
        query === 'Sago Palm'
          ? [{ term: 'sago palm', outcome: 'filed', summary: '', score: 0.9 }]
          : query === 'oleander'
            ? [{ term: 'foxglove', outcome: 'filed', summary: '', score: 0.4 }]
            : [],
      remember,
    };

    const result = await backfillMemory(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      memory,
    );

    expect(result).toEqual({ written: 2, skipped: 3 });
    expect(remember.mock.calls.map(([record]) => [record.term, record.outcome])).toEqual([
      ['Xylitol', 'unknown'],
      ['oleander', 'not_hazard'],
    ]);
    expect(db.commandCalls(ScanCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({
      PK: 'SCRAPERTREND#nfl scores',
      SK: 'META',
    });
  });
});
