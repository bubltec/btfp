import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { randomUUID } from 'node:crypto';
import {
  applyContributionToThing,
  clusterPendingContributions,
  contributionsMatch,
  isReviewableContribution,
  mergeThingPayload,
  planContributionAttach,
  previewContribution,
  type Contribution,
  type PendingContributionCard,
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
  private readonly log = new Logger(ContributionsService.name);

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

  /**
   * The moderation queue. Rows with no name or type are left out: nobody can act on
   * them (approve refuses them), and they used to render as "(no name)". Each card
   * carries a preview of what approving it would change.
   */
  async listPending(limit = 50): Promise<PendingContributionCard[]> {
    const reviewable = (await this.queue.listAll()).filter(isReviewableContribution);
    const cards = clusterPendingContributions(reviewable).slice(0, limit);
    const now = new Date().toISOString();
    return Promise.all(cards.map((card) => this.withPreview(card, now)));
  }

  private async withPreview(card: Contribution, now: string): Promise<PendingContributionCard> {
    try {
      // Same lookup approve() does, so the preview matches what approval will merge into.
      const existing = card.thingId
        ? await this.things.getById(card.thingId)
        : ((await this.search.findDuplicate(card.payload as ThingIdentity)) ?? null);
      return {
        ...card,
        preview: {
          changes: previewContribution(existing, card, now),
          ...(existing && !card.thingId
            ? { mergesInto: { id: existing.id, name: existing.name } }
            : {}),
          ...(card.thingId && !existing ? { targetMissing: true } : {}),
        },
      };
    } catch (err) {
      // One bad legacy row must not blank the whole queue.
      this.log.warn(`Preview failed for contribution ${card.id}: ${String(err)}`);
      return { ...card, preview: { changes: [], unavailable: true } };
    }
  }

  async reject(
    thingId: string,
    sk: string,
    reviewerId: string,
    reason?: string,
  ): Promise<{ rejected: number }> {
    const contribution = await this.queue.get(thingId, sk);
    if (!contribution) throw new NotFoundException('Contribution not found');
    if (contribution.status !== 'pending') {
      throw new BadRequestException('Contribution was already reviewed');
    }
    // Reject the whole card. The queue shows one card per identity (newest row, older
    // ones folded in), so rejecting only the newest would surface an older sibling.
    const siblings = isReviewableContribution(contribution)
      ? (await this.queue.listAll()).filter(
          (row) =>
            row.SK !== contribution.SK && hasPayload(row) && contributionsMatch(contribution, row),
        )
      : [];
    await this.queue.markRejected(
      [contribution, ...siblings],
      reviewerId,
      new Date().toISOString(),
      reason?.trim() || undefined,
    );
    return { rejected: 1 + siblings.length };
  }

  async approve(thingId: string, sk: string, reviewerId: string): Promise<Thing> {
    const contribution = await this.queue.get(thingId, sk);
    if (!contribution) throw new NotFoundException('Contribution not found');
    if (!hasPayload(contribution)) {
      throw new BadRequestException('Contribution is missing payload and cannot be approved');
    }
    if (!isReviewableContribution(contribution)) {
      throw new BadRequestException(
        'Contribution has no name or type and cannot be approved; reject it instead',
      );
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

    // The same function the moderation preview uses, so what a moderator saw is what happens.
    const thing = applyContributionToThing(existingThing ?? null, payload, {
      fallbackId: contribution.thingId ?? thingId,
      contributorId: contribution.contributorId,
      now,
    });
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
