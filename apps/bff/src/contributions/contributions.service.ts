import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { mergeThings, type Contribution, type Thing, type ThingIdentity } from '@btfp/shared-types';
import { DYNAMO_DOC_CLIENT } from '@bubltec/mycota-dynamo';
import { UsersService } from '@bubltec/mycota-auth';
import { CONTENT_TABLE_NAME } from '../dynamo/dynamo.constants.js';
import { ThingsService } from '../things/things.service.js';
import { SearchService } from '../search/search.service.js';
import type { CreateContributionDto } from './dto/create-contribution.dto.js';

@Injectable()
export class ContributionsService {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly things: ThingsService,
    private readonly users: UsersService,
    private readonly search: SearchService,
  ) {}

  async propose(dto: CreateContributionDto, contributorId: string): Promise<Contribution> {
    const contributor = contributorId?.trim();
    if (!contributor) {
      throw new BadRequestException('Session is missing a contributor id — sign in again');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const linkedThingId = normalizeLinkedThingId(dto.thingId);
    const duplicateId =
      !linkedThingId && dto.payload.name && dto.payload.thingTypeId
        ? normalizeLinkedThingId((await this.search.findDuplicate(dto.payload))?.id)
        : undefined;
    const existingId = linkedThingId ?? duplicateId;
    const contribution: Contribution = {
      id,
      thingId: existingId,
      contributorId: contributor,
      status: 'pending',
      payload: dto.payload,
      createdAt: now,
    };

    const targetThingId = existingId ?? id;
    await this.db.send(
      new PutCommand({
        TableName: CONTENT_TABLE_NAME,
        Item: {
          ...contribution,
          PK: `THING#${targetThingId}`,
          SK: `CONTRIB#${now}#${contributor}`,
          GSI2PK: 'STATUS#pending',
          GSI2SK: `CONTRIB#${now}`,
        },
      }),
    );

    return contribution;
  }

  async listPending(limit = 50): Promise<Contribution[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: CONTENT_TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': 'STATUS#pending' },
        Limit: limit,
      }),
    );
    return (result.Items ?? []) as Contribution[];
  }

  async approve(thingId: string, sk: string, reviewerId: string): Promise<Thing> {
    const existing = await this.db.send(
      new GetCommand({ TableName: CONTENT_TABLE_NAME, Key: { PK: `THING#${thingId}`, SK: sk } }),
    );
    const contribution = existing.Item as (Contribution & { PK: string; SK: string }) | undefined;
    if (!contribution) throw new NotFoundException('Contribution not found');

    const now = new Date().toISOString();
    const contributor = await this.users.getById(contribution.contributorId);
    const payload = contribution.payload;
    // Explicit edits target contribution.thingId. A "new" thing that matches
    // an existing row is folded into that row instead of inserting a duplicate.
    const duplicate =
      !contribution.thingId && payload.name && payload.thingTypeId
        ? await this.search.findDuplicate(payload as ThingIdentity)
        : undefined;
    const existingThing = contribution.thingId
      ? await this.things.getById(contribution.thingId)
      : (duplicate ?? null);

    const details = { ...existingThing?.details, ...payload.details };
    if (contributor?.professional?.status === 'verified') {
      details.verifiedOrgDomain = contributor.professional.domain;
    }

    const incoming: Thing = {
      id: existingThing?.id ?? contribution.thingId ?? thingId,
      name: payload.name ?? existingThing?.name ?? 'Unnamed',
      otherNames: payload.otherNames ?? existingThing?.otherNames ?? [],
      thingTypeId: payload.thingTypeId ?? existingThing?.thingTypeId ?? 'unknown',
      petTypes: payload.petTypes ?? existingThing?.petTypes ?? [],
      details,
      source:
        payload.source ?? existingThing?.source ?? `contributor:${contribution.contributorId}`,
      sourceUrl: payload.sourceUrl ?? existingThing?.sourceUrl,
      verified: true,
      contributorId: contribution.contributorId,
      createdAt: existingThing?.createdAt ?? now,
      updatedAt: now,
    };

    const thing: Thing = !existingThing
      ? incoming
      : contribution.thingId
        ? {
            ...existingThing,
            ...incoming,
            id: existingThing.id,
            details,
            createdAt: existingThing.createdAt,
          }
        : {
            ...mergeThings(existingThing, incoming),
            verified: true,
            contributorId: contribution.contributorId,
            updatedAt: now,
            details,
          };
    await this.things.putThing(thing);

    await this.db.send(
      new UpdateCommand({
        TableName: CONTENT_TABLE_NAME,
        Key: { PK: `THING#${thingId}`, SK: sk },
        UpdateExpression:
          'SET #status = :approved, reviewedAt = :now, reviewerId = :reviewer REMOVE GSI2PK, GSI2SK',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':approved': 'approved',
          ':now': now,
          ':reviewer': reviewerId,
        },
      }),
    );

    return thing;
  }
}

function normalizeLinkedThingId(id: string | undefined): string | undefined {
  if (id == null) return undefined;
  const trimmed = String(id).trim();
  return trimmed || undefined;
}
