import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateContributionDto } from './dto/create-contribution.dto.js';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ContributionsService } from './contributions.service.js';
import type { SearchService } from '../search/search.service.js';

const e2ePayload: CreateContributionDto = {
  payload: {
    name: 'Chocolate',
    thingTypeId: 'food',
    petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
    details: { notes: 'toxic to dogs' },
    source: 'e2e',
  },
};

const pipe = new ValidationPipe({ whitelist: true, transform: true });

describe('ContributionsService.propose', () => {
  it('plainifies ValidationPipe class instances before PutCommand', async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const dto = (await pipe.transform(e2ePayload, {
      type: 'body',
      metatype: CreateContributionDto,
    })) as CreateContributionDto;

    const service = new ContributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      {} as never,
      {} as never,
      { findDuplicate: vi.fn().mockResolvedValue(undefined) } as unknown as SearchService,
    );

    await service.propose(dto, 'e2e-user');
    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    const payload = item.payload as Record<string, unknown>;
    expect(payload.constructor).toBe(Object);
    expect((payload.petTypes as unknown[])[0]).toMatchObject({ petTypeId: 'dog' });
    expect((payload.petTypes as unknown[])[0]?.constructor).toBe(Object);
  });

  it('writes the same DynamoDB item shape as the scraper (new thing, no duplicate)', async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const search = {
      findDuplicate: vi.fn().mockResolvedValue(undefined),
    } as unknown as SearchService;

    const service = new ContributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      {} as never,
      {} as never,
      search,
    );

    const contribution = await service.propose(e2ePayload, 'e2e-user');

    expect(contribution.thingId).toBeUndefined();
    expect(search.findDuplicate).toHaveBeenCalledWith(e2ePayload.payload);

    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe(`THING#${contribution.id}`);
    expect(item.SK).toBe(`CONTRIB#${contribution.createdAt}#e2e-user`);
    expect(item.GSI2PK).toBe('STATUS#pending');
    expect(item.payload).toMatchObject({ name: 'Chocolate', thingTypeId: 'food' });
    expect(item).not.toHaveProperty('thingId');
  });

  it('rejects a session with no contributor id', async () => {
    const service = new ContributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      {} as never,
      {} as never,
      { findDuplicate: vi.fn() } as unknown as SearchService,
    );
    await expect(service.propose(e2ePayload, '  ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores a blank duplicate id and creates a new Thing partition', async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const search = {
      findDuplicate: vi
        .fn()
        .mockResolvedValue({ id: '   ', name: 'Chocolate', thingTypeId: 'food' }),
    } as unknown as SearchService;

    const service = new ContributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      {} as never,
      {} as never,
      search,
    );

    const contribution = await service.propose(e2ePayload, 'e2e-user');
    expect(contribution.thingId).toBeUndefined();
    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe(`THING#${contribution.id}`);
  });

  it('attaches to an existing Thing id when findDuplicate matches', async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const search = {
      findDuplicate: vi.fn().mockResolvedValue({
        id: 'existing-chocolate',
        name: 'Chocolate',
        thingTypeId: 'food',
      }),
    } as unknown as SearchService;

    const service = new ContributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      {} as never,
      {} as never,
      search,
    );

    const contribution = await service.propose(e2ePayload, 'e2e-user');

    expect(contribution.thingId).toBe('existing-chocolate');
    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe('THING#existing-chocolate');
  });
});
