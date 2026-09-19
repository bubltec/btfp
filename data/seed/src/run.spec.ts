import { describe, it, expect, beforeEach } from 'vitest';
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { findOrphanedSeedThingKeys, batchWrite, CONTENT_TABLE_NAME } from './run.js';

describe('findOrphanedSeedThingKeys', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  beforeEach(() => {
    ddbMock.reset();
  });

  it('flags seed-produced rows (no contributorId) whose id is no longer emitted', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { PK: 'THING#old-onion-combo', SK: 'META', name: 'Onions, garlic, leeks…' },
        { PK: 'THING#onion', SK: 'META', name: 'Onion' },
      ],
    });

    const orphans = await findOrphanedSeedThingKeys(db, new Set(['onion']));

    expect(orphans).toEqual([{ PK: 'THING#old-onion-combo', SK: 'META' }]);
  });

  it('never flags rows that went through the contributions/approve flow', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        // Shares an id with a stable id no longer produced, but was
        // enriched by a contributor — must be left alone.
        { PK: 'THING#old-onion-combo', SK: 'META', contributorId: 'user-123' },
      ],
    });

    const orphans = await findOrphanedSeedThingKeys(db, new Set());

    expect(orphans).toEqual([]);
  });

  it('keeps rows whose id is still produced by the current run', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ PK: 'THING#onion', SK: 'META' }],
    });

    const orphans = await findOrphanedSeedThingKeys(db, new Set(['onion']));

    expect(orphans).toEqual([]);
  });

  it('paginates through the full table scan', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ PK: 'THING#stale-a', SK: 'META' }],
        LastEvaluatedKey: { PK: 'THING#stale-a', SK: 'META' },
      })
      .resolvesOnce({
        Items: [{ PK: 'THING#stale-b', SK: 'META' }],
      });

    const orphans = await findOrphanedSeedThingKeys(db, new Set());

    expect(orphans).toEqual([
      { PK: 'THING#stale-a', SK: 'META' },
      { PK: 'THING#stale-b', SK: 'META' },
    ]);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });

  it('scans the configured content table', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await findOrphanedSeedThingKeys(db, new Set());

    expect(ddbMock.commandCalls(ScanCommand)[0]?.args[0].input.TableName).toBe(CONTENT_TABLE_NAME);
  });
});

describe('batchWrite', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  beforeEach(() => {
    ddbMock.reset();
  });

  it('retries items DynamoDB reports as UnprocessedItems instead of silently dropping them', async () => {
    const items = [
      { PK: 'THING#a', SK: 'META' },
      { PK: 'THING#b', SK: 'META' },
    ];
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({
        // Simulates throttling: only "a" succeeds first try.
        UnprocessedItems: {
          [CONTENT_TABLE_NAME]: [{ PutRequest: { Item: items[1] } }],
        },
      })
      .resolvesOnce({});

    await batchWrite(db, items);

    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it('throws instead of silently dropping rows if items are still unprocessed after all retries', async () => {
    const items = [{ PK: 'THING#a', SK: 'META' }];
    ddbMock.on(BatchWriteCommand).resolves({
      UnprocessedItems: { [CONTENT_TABLE_NAME]: [{ PutRequest: { Item: items[0] } }] },
    });

    await expect(batchWrite(db, items)).rejects.toThrow(/unprocessed/i);
  }, 10_000);

  it('succeeds in one call when nothing is throttled', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});

    await batchWrite(db, [{ PK: 'THING#a', SK: 'META' }]);

    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });
});
