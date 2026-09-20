import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { randomUUID } from 'node:crypto';
import {
  clusterPendingContributions,
  contributionsMatch,
  mergeThingPayload,
  mergeThings,
  planContributionAttach,
  type Contribution,
  type Thing,
  type ThingIdentity,
} from '@btfp/shared-types';
import { UsersService } from '@bubltec/mycota-auth';
import { ThingsService } from '../things/things.service.js';
import { SearchService } from '../search/search.service.js';
import type { CreateContributionDto } from './dto/create-contribution.dto.js';
import { PendingContributionStore, type PendingRow } from './pending-contribution.store.js';

@Injectable()
export class ContributionsService {
  constructor(
    private readonly queue: PendingContributionStore,
    private readonly things: ThingsService,
    private readonly users: UsersService,
    private readonly search: SearchService,
  ) {}

  async propose(dto: CreateContributionDto, contributorId: string): Promise<Contribution> {
    const contributor = contributorId?.trim();
    if (!contributor) {
      throw new BadRequestException('Session is missing a contributor id — sign in again');
    }
    if (!dto.payload?.name || !dto.payload?.thingTypeId) {
      throw new BadRequestException('payload.name and payload.thingTypeId are required');
    }

    const payload = JSON.parse(
      JSON.stringify(instanceToPlain(dto.payload)),
    ) as Contribution['payload'];
    const identity = payload as ThingIdentity;
    const linkedThingId = normalizeLinkedThingId(dto.thingId);
    const catalogMatchId = !linkedThingId
      ? normalizeLinkedThingId((await this.search.findDuplicate(identity))?.id)
      : undefined;
    // Full pending set (not Limit) so attach can see older cards of the same
    // identity. The queue is small; this is a GSI Query, not a table Scan.
    const pending = await this.queue.listAll();
    const { pendingMatch, thingId } = planContributionAttach({
      payload: identity,
      explicitThingId: linkedThingId,
      catalogMatchId,
      pending,
    });

    if (pendingMatch) {
      const existing = pendingMatch as PendingRow;
      const merged = mergeThingPayload(existing.payload, payload);
      const linked = thingId ?? existing.thingId;
      if (!existing.SK) {
        return this.insertPending(payload, linked, contributor);
      }
      await this.queue.accumulate(existing, payload, linked);
      return { ...existing, payload: merged, thingId: linked };
    }

    return this.insertPending(payload, thingId, contributor);
  }

  async listPending(limit = 50): Promise<Contribution[]> {
    return clusterPendingContributions(await this.queue.listAll()).slice(0, limit);
  }

  async approve(thingId: string, sk: string, reviewerId: string): Promise<Thing> {
    const contribution = await this.queue.get(thingId, sk);
    if (!contribution) throw new NotFoundException('Contribution not found');
    if (!hasPayload(contribution)) {
      throw new BadRequestException('Contribution is missing payload and cannot be approved');
    }

    const siblings = (await this.queue.listAll()).filter(
      (row) =>
        row.SK !== contribution.SK && hasPayload(row) && contributionsMatch(contribution, row),
    );
    let payload = contribution.payload;
    for (const sibling of siblings) {
      payload = mergeThingPayload(payload, sibling.payload);
    }

    const now = new Date().toISOString();
    const contributor = await this.users.getById(contribution.contributorId);
    const duplicate =
      !contribution.thingId && payload.name && payload.thingTypeId
        ? await this.search.findDuplicate(payload as ThingIdentity)
        : undefined;
    const existingThing = contribution.thingId
      ? await this.things.getById(contribution.thingId)
      : (duplicate ?? null);

    const incoming: Thing = {
      id: existingThing?.id ?? contribution.thingId ?? thingId,
      name: payload.name ?? existingThing?.name ?? 'Unnamed',
      otherNames: payload.otherNames ?? existingThing?.otherNames ?? [],
      thingTypeId: payload.thingTypeId ?? existingThing?.thingTypeId ?? 'unknown',
      petTypes: payload.petTypes ?? existingThing?.petTypes ?? [],
      details: payload.details ?? {},
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
      : {
          ...mergeThings(existingThing, incoming),
          verified: true,
          contributorId: contribution.contributorId,
          updatedAt: now,
        };
    if (contributor?.professional?.status === 'verified') {
      thing.details = {
        ...thing.details,
        verifiedOrgDomain: contributor.professional.domain,
      };
    }
    await this.things.putThing(thing);
    await this.queue.markApproved([contribution, ...siblings], reviewerId, now);
    return thing;
  }

  private async insertPending(
    payload: Contribution['payload'],
    thingId: string | undefined,
    contributorId: string,
  ): Promise<Contribution> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const contribution: Contribution = {
      id,
      thingId,
      contributorId,
      status: 'pending',
      payload,
      createdAt: now,
    };
    await this.queue.insert(contribution, thingId);
    return contribution;
  }
}

function hasPayload(item: Contribution | undefined): item is Contribution {
  return Boolean(item?.payload && typeof item.payload === 'object');
}

function normalizeLinkedThingId(id: string | undefined): string | undefined {
  if (id == null) return undefined;
  const trimmed = String(id).trim();
  return trimmed || undefined;
}
