import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { CreateContributionDto } from './dto/create-contribution.dto.js';
import { mockAws } from '../test-utils.js';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ContributionsService } from './contributions.service.js';
import { DynamoPendingContributionStore } from './dynamo-pending-contribution.store.js';
import type { SearchService } from '../search/search.service.js';
import { VALIDATION_PIPE_OPTIONS } from '../validation.js';
import { PendingContributionStore, type PendingRow } from './pending-contribution.store.js';
import type { Thing } from '@btfp/shared-types';

function contributionsService(
  db: DynamoDBDocumentClient,
  search: SearchService,
): ContributionsService {
  return new ContributionsService(
    new DynamoPendingContributionStore(db),
    {} as never,
    {} as never,
    search,
  );
}

const e2ePayload: CreateContributionDto = {
  payload: {
    name: 'Chocolate',
    thingTypeId: 'food',
    petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
    details: { notes: 'toxic to dogs' },
    source: 'e2e',
  },
};

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

describe('ContributionsService.propose', () => {
  it('plainifies ValidationPipe class instances before PutCommand', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const dto = (await pipe.transform(e2ePayload, {
      type: 'body',
      metatype: CreateContributionDto,
    })) as CreateContributionDto;

    const service = contributionsService(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
      findDuplicate: vi.fn().mockResolvedValue(undefined),
    } as unknown as SearchService);

    await service.propose(dto, 'e2e-user');
    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    const payload = item.payload as Record<string, unknown>;
    expect(payload.constructor).toBe(Object);
    expect((payload.petTypes as unknown[])[0]).toMatchObject({ petTypeId: 'dog' });
    expect((payload.petTypes as unknown[])[0]?.constructor).toBe(Object);
  });

  it('writes the same DynamoDB item shape as the scraper (new thing, no duplicate)', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const search = {
      findDuplicate: vi.fn().mockResolvedValue(undefined),
    } as unknown as SearchService;

    const service = contributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
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
    const service = contributionsService(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
      findDuplicate: vi.fn(),
    } as unknown as SearchService);
    await expect(service.propose(e2ePayload, '  ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores a blank duplicate id and creates a new Thing partition', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const search = {
      findDuplicate: vi
        .fn()
        .mockResolvedValue({ id: '   ', name: 'Chocolate', thingTypeId: 'food' }),
    } as unknown as SearchService;

    const service = contributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      search,
    );

    const contribution = await service.propose(e2ePayload, 'e2e-user');
    expect(contribution.thingId).toBeUndefined();
    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe(`THING#${contribution.id}`);
  });

  it('attaches to an existing Thing id when findDuplicate matches', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const search = {
      findDuplicate: vi.fn().mockResolvedValue({
        id: 'existing-chocolate',
        name: 'Chocolate',
        thingTypeId: 'food',
      }),
    } as unknown as SearchService;

    const service = contributionsService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      search,
    );

    const contribution = await service.propose(e2ePayload, 'e2e-user');

    expect(contribution.thingId).toBe('existing-chocolate');
    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe('THING#existing-chocolate');
  });

  it('merges a later Chocolate submit into the existing pending row', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(QueryCommand).resolves({
      Items: [
        {
          id: 'queued',
          PK: 'THING#existing-chocolate',
          SK: 'CONTRIB#2026-01-01T00:00:00.000Z#e2e-user',
          thingId: 'existing-chocolate',
          contributorId: 'e2e-user',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          payload: { name: 'Chocolate', thingTypeId: 'food', details: { notes: 'theobromine' } },
        },
      ],
    });
    db.on(UpdateCommand).resolves({});

    const service = contributionsService(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
      findDuplicate: vi.fn().mockResolvedValue({
        id: 'existing-chocolate',
        name: 'Chocolate',
        thingTypeId: 'food',
      }),
    } as unknown as SearchService);

    const contribution = await service.propose(
      {
        payload: {
          name: 'Chocolate',
          thingTypeId: 'food',
          petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
          details: { notes: 'theobromine', clinicalSigns: 'vomiting' },
          source: 'e2e',
        },
      },
      'e2e-user',
    );

    expect(db.commandCalls(PutCommand)).toHaveLength(0);
    expect(contribution.thingId).toBe('existing-chocolate');
    expect(contribution.payload.details).toEqual({
      notes: 'theobromine',
      clinicalSigns: 'vomiting',
    });
    const update = db.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update.Key).toEqual({
      PK: 'THING#existing-chocolate',
      SK: 'CONTRIB#2026-01-01T00:00:00.000Z#e2e-user',
    });
  });
});

describe('ContributionsService.listPending', () => {
  it('drops queue rows that have no payload (legacy contribs crash the moderation UI)', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(QueryCommand).resolves({
      Items: [
        { PK: 'THING#old', SK: 'CONTRIB#1', contributorId: 'x', status: 'pending' },
        {
          PK: 'THING#new',
          SK: 'CONTRIB#2',
          contributorId: 'y',
          status: 'pending',
          payload: { name: 'Xylitol', thingTypeId: 'food' },
        },
      ],
    });

    const service = contributionsService(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
      findDuplicate: vi.fn(),
    } as unknown as SearchService);

    const pending = await service.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toMatchObject({ name: 'Xylitol' });
    expect(db.commandCalls(QueryCommand)[0]?.args[0].input.ScanIndexForward).toBe(false);
  });

  it('shows one queue card for several pending Chocolate edits', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(QueryCommand).resolves({
      Items: [
        {
          id: '1',
          createdAt: '2026-01-02T00:00:00.000Z',
          thingId: 'choc',
          payload: { name: 'Chocolate', thingTypeId: 'food' },
        },
        {
          id: '2',
          createdAt: '2026-01-01T00:00:00.000Z',
          thingId: 'choc',
          payload: { name: 'Chocolate', thingTypeId: 'food', details: { notes: 'toxic' } },
        },
      ],
    });

    const service = contributionsService(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
      findDuplicate: vi.fn(),
    } as unknown as SearchService);

    const pending = await service.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('1');
    expect(pending[0]?.payload.details).toEqual({ notes: 'toxic' });
  });
});

// --- moderation queue: filtering, previews, reject ---------------------------------

class FakeQueue extends PendingContributionStore {
  rejected: { rows: PendingRow[]; reviewerId: string; reason?: string }[] = [];
  constructor(readonly rows: PendingRow[]) {
    super();
  }
  async listAll() {
    return this.rows.filter((r) => r.payload && typeof r.payload === 'object');
  }
  async get(thingId: string, sk: string) {
    return this.rows.find((r) => r.PK === `THING#${thingId}` && r.SK === sk);
  }
  async insert() {}
  async accumulate() {}
  async markApproved() {}
  async markRejected(rows: PendingRow[], reviewerId: string, _now: string, reason?: string) {
    this.rejected.push({ rows, reviewerId, reason });
  }
}

const chocolateThing: Thing = {
  id: 'choc',
  name: 'Chocolate',
  otherNames: [],
  thingTypeId: 'food',
  petTypes: [{ petTypeId: 'dog', severity: 'mild' }],
  details: {},
  source: 'aspca',
  verified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function row(over: Partial<PendingRow> & { SK: string }): PendingRow {
  return {
    id: over.SK,
    PK: 'THING#x',
    contributorId: 'u1',
    status: 'pending',
    createdAt: '2026-02-01T00:00:00.000Z',
    payload: { name: 'Grapes', thingTypeId: 'food' },
    ...over,
  };
}

function queueService(
  rows: PendingRow[],
  deps: {
    getById?: (id: string) => Promise<Thing | null>;
    findDuplicate?: () => Promise<Thing | undefined>;
  } = {},
) {
  const queue = new FakeQueue(rows);
  const service = new ContributionsService(
    queue,
    { getById: deps.getById ?? (async () => null) } as never,
    {} as never,
    { findDuplicate: deps.findDuplicate ?? (async () => undefined) } as unknown as SearchService,
  );
  return { service, queue };
}

describe('ContributionsService.listPending: what a moderator can act on', () => {
  it('leaves out rows with no name or type instead of rendering "(no name)"', async () => {
    const { service } = queueService([
      row({ SK: 'a', payload: {} }),
      row({ SK: 'b', payload: { source: 'agentcore', details: { summary: 's' } } }),
      row({ SK: 'c', payload: { name: 'Grapes' } }),
      row({ SK: 'd', payload: { thingTypeId: 'food' } }),
      row({ SK: 'e', payload: { name: 'Grapes', thingTypeId: 'food' } }),
    ]);
    const cards = await service.listPending();
    expect(cards.map((c) => c.SK)).toEqual(['e']);
  });

  it('previews an edit against the live entry: what approval will change', async () => {
    const getById = vi.fn(async () => chocolateThing);
    const { service } = queueService(
      [
        row({
          SK: 'e1',
          thingId: 'choc',
          payload: {
            name: 'Chocolate',
            thingTypeId: 'food',
            petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
          },
        }),
      ],
      { getById },
    );
    const [card] = await service.listPending();
    expect(getById).toHaveBeenCalledWith('choc');
    expect(card?.preview.mergesInto).toBeUndefined();
    expect(card?.preview.changes).toContainEqual({
      field: 'petTypes.dog',
      label: 'Dangerous for dog',
      kind: 'changed',
      before: 'mild',
      after: 'severe',
    });
  });

  it('says which entry a new-looking card will merge into when the catalog already has it', async () => {
    const { service } = queueService(
      [row({ SK: 'n1', payload: { name: 'Choc', thingTypeId: 'food', otherNames: [] } })],
      { findDuplicate: async () => chocolateThing },
    );
    const [card] = await service.listPending();
    expect(card?.preview.mergesInto).toEqual({ id: 'choc', name: 'Chocolate' });
  });

  it('lists every field as added for a genuinely new entry', async () => {
    const { service } = queueService([
      row({
        SK: 'n2',
        payload: {
          name: 'Grapes',
          thingTypeId: 'food',
          petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
          details: { notes: 'Kidney failure' },
        },
      }),
    ]);
    const [card] = await service.listPending();
    expect(card?.preview.changes.every((c) => c.kind === 'added')).toBe(true);
    expect(card?.preview.changes.map((c) => c.field)).toContain('details.notes');
  });

  it('flags a card whose linked entry no longer exists (approval would create a new one)', async () => {
    const { service } = queueService([row({ SK: 'm1', thingId: 'gone' })], {
      getById: async () => null,
    });
    const [card] = await service.listPending();
    expect(card?.preview.targetMissing).toBe(true);
  });

  it('a preview failure on one card does not blank the queue', async () => {
    const { service } = queueService(
      [
        row({ SK: 'bad', thingId: 'boom', createdAt: '2026-02-02T00:00:00.000Z' }),
        row({ SK: 'ok', payload: { name: 'Xylitol', thingTypeId: 'food' } }),
      ],
      {
        getById: async (id) => {
          if (id === 'boom') throw new Error('legacy row exploded');
          return null;
        },
      },
    );
    const cards = await service.listPending();
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.SK === 'bad')?.preview).toEqual({ changes: [], unavailable: true });
    expect(cards.find((c) => c.SK === 'ok')?.preview.unavailable).toBeUndefined();
  });
});

describe('ContributionsService.reject', () => {
  it('rejects the whole card: the newest row and the older rows folded into it', async () => {
    const { service, queue } = queueService([
      row({ PK: 'THING#g', SK: 'new', createdAt: '2026-02-02T00:00:00.000Z' }),
      row({ PK: 'THING#g2', SK: 'old', createdAt: '2026-02-01T00:00:00.000Z' }),
      row({
        PK: 'THING#other',
        SK: 'unrelated',
        payload: { name: 'Xylitol', thingTypeId: 'food' },
      }),
    ]);
    const result = await service.reject('g', 'new', 'reviewer-1', '  spam  ');
    expect(result).toEqual({ rejected: 2 });
    expect(queue.rejected).toHaveLength(1);
    expect(queue.rejected[0]?.rows.map((r) => r.SK).sort()).toEqual(['new', 'old']);
    expect(queue.rejected[0]).toMatchObject({ reviewerId: 'reviewer-1', reason: 'spam' });
  });

  it('rejects a row with no name on its own, without pulling in unrelated rows', async () => {
    const { service, queue } = queueService([
      row({ PK: 'THING#a', SK: 'nameless', payload: {} }),
      row({ PK: 'THING#b', SK: 'other' }),
    ]);
    expect(await service.reject('a', 'nameless', 'r1')).toEqual({ rejected: 1 });
    expect(queue.rejected[0]?.rows.map((r) => r.SK)).toEqual(['nameless']);
    expect(queue.rejected[0]?.reason).toBeUndefined();
  });

  it('404s for a missing row and refuses one that was already reviewed', async () => {
    const { service } = queueService([
      row({ PK: 'THING#done', SK: 'approved', status: 'approved' }),
    ]);
    await expect(service.reject('nope', 'x', 'r1')).rejects.toThrow(NotFoundException);
    await expect(service.reject('done', 'approved', 'r1')).rejects.toThrow(BadRequestException);
  });
});

describe('ContributionsService.approve: unreviewable rows', () => {
  it('refuses a row with no name or type, rather than minting an "Unnamed" entry', async () => {
    const { service } = queueService([
      row({ PK: 'THING#a', SK: 'nameless', payload: { source: 's' } }),
    ]);
    await expect(service.approve('a', 'nameless', 'r1')).rejects.toThrow(/reject it instead/);
  });
});
