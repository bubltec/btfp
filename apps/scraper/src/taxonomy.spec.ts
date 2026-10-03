import { describe, expect, it } from 'vitest';
import { mockAws } from './test-utils.js';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadTaxonomy } from './taxonomy.js';

describe('loadTaxonomy', () => {
  it('scans both PETTYPE# and THINGTYPE# prefixes and returns their ids and display names', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(ScanCommand, {
      ExpressionAttributeValues: { ':meta': 'META', ':prefix': 'THINGTYPE#' },
    }).resolves({ Items: [{ id: 'plant', name: 'Plant' }, { id: 'food' }] });
    db.on(ScanCommand, {
      ExpressionAttributeValues: { ':meta': 'META', ':prefix': 'PETTYPE#' },
    }).resolves({ Items: [{ id: 'dog' }, { id: 'cat' }] });

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await loadTaxonomy(client);

    expect(result).toEqual({
      thingTypeIds: ['plant', 'food'],
      petTypeIds: ['dog', 'cat'],
      thingTypeNames: { plant: 'Plant' },
      petTypeNames: {},
    });
  });

  it('falls back to a single "unknown" id when a scan comes back empty', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(ScanCommand).resolves({ Items: [] });

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await loadTaxonomy(client);

    expect(result).toMatchObject({ thingTypeIds: ['unknown'], petTypeIds: ['unknown'] });
  });
});
