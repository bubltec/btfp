import 'reflect-metadata';
/**
 * Regression guard for deploy e2e: PR CI runs these (mock Dynamo), not Playwright
 * against dev. See docs/e2e-testing.md — use `pnpm --filter @btfp/e2e test:dev`
 * before merging contribution changes.
 */
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { mockAws } from '../test-utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CreateContributionDto } from './dto/create-contribution.dto.js';
import { ContributionsService } from './contributions.service.js';
import { DynamoPendingContributionStore } from './dynamo-pending-contribution.store.js';
import type { SearchService } from '../search/search.service.js';

const pipe = new ValidationPipe({ whitelist: true, transform: true });

const e2eSubmitBody = {
  payload: {
    name: 'Chocolate',
    thingTypeId: 'food',
    petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
    details: {
      notes:
        'Chocolate contains theobromine and caffeine, which are toxic to dogs and can cause vomiting, seizures, and death.',
    },
    source:
      'https://www.aspca.org/pet-care/animal-poison-control/toxic-and-non-toxic-plants/chocolate',
  },
};

describe('Contributions POST pipeline (ValidationPipe → propose → PutCommand)', () => {
  it('matches the deploy e2e submit body and produces a plain Put item', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const dto = (await pipe.transform(e2eSubmitBody, {
      type: 'body',
      metatype: CreateContributionDto,
    })) as CreateContributionDto;

    const service = new ContributionsService(
      new DynamoPendingContributionStore(
        DynamoDBDocumentClient.from(new DynamoDBClient({}), {
          marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
        }),
      ),
      {} as never,
      {} as never,
      { findDuplicate: vi.fn().mockResolvedValue(undefined) } as unknown as SearchService,
    );

    await service.propose(dto, 'e2e-user');

    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.payload).toMatchObject({ name: 'Chocolate', thingTypeId: 'food' });
    expect((item.payload as Record<string, unknown>).constructor).toBe(Object);
  });
});
