import { describe, expect, it, vi } from 'vitest';
import { mockAws } from '../test-utils.js';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SearchService } from './search.service.js';
import type { BreedsService } from '../breeds/breeds.service.js';

describe('SearchService.findDuplicate', () => {
  it('falls back to PK when META rows are missing id', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(ScanCommand).resolves({
      Items: [
        {
          PK: 'THING#from-pk',
          SK: 'META',
          name: 'Chocolate / cocoa',
          thingTypeId: 'food',
          otherNames: [],
          petTypes: [],
          details: {},
          source: 'seed',
          verified: true,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    });

    const service = new SearchService(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
      getById: vi.fn(),
    } as unknown as BreedsService);

    await expect(
      service.findDuplicate({ name: 'Chocolate', thingTypeId: 'food' }),
    ).resolves.toMatchObject({ id: 'from-pk' });
  });

  it('does not throw when the catalog contains malformed Thing rows', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(ScanCommand).resolves({
      Items: [
        {
          PK: 'THING#broken',
          SK: 'META',
          id: 'broken',
          name: '',
          thingTypeId: 'food',
          otherNames: ['ok', 99],
          petTypes: [],
          details: {},
          source: 'legacy',
          verified: false,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
        {
          PK: 'THING#choc',
          SK: 'META',
          id: 'choc',
          name: 'Chocolate / cocoa',
          thingTypeId: 'food',
          otherNames: [],
          petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
          details: {},
          source: 'seed',
          verified: true,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    });

    const service = new SearchService(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
      getById: vi.fn(),
    } as unknown as BreedsService);

    await expect(
      service.findDuplicate({ name: 'Chocolate', thingTypeId: 'food' }),
    ).resolves.toMatchObject({ id: 'choc' });
  });
});
