import type { Contribution } from '@btfp/shared-types';

export type PendingRow = Contribution & { PK?: string; SK?: string };

/**
 * Port for the pending-contribution queue. Dynamo adapter in
 * `dynamo-pending-contribution.store.ts`; tests pass a fake.
 */
export abstract class PendingContributionStore {
  abstract listAll(): Promise<PendingRow[]>;
  abstract get(thingId: string, sk: string): Promise<PendingRow | undefined>;
  abstract insert(contribution: Contribution, thingId: string | undefined): Promise<void>;
  abstract accumulate(
    existing: PendingRow,
    payload: Contribution['payload'],
    thingId: string | undefined,
  ): Promise<void>;
  abstract markApproved(rows: PendingRow[], reviewerId: string, now: string): Promise<void>;
}
