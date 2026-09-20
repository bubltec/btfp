import { Inject, Injectable } from '@nestjs/common';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { mergeThingPayload, type Contribution } from '@btfp/shared-types';
import { DYNAMO_DOC_CLIENT } from '@bubltec/mycota-dynamo';
import { CONTENT_TABLE_NAME } from '../dynamo/dynamo.constants.js';
import { PendingContributionStore, type PendingRow } from './pending-contribution.store.js';

@Injectable()
export class DynamoPendingContributionStore extends PendingContributionStore {
  constructor(@Inject(DYNAMO_DOC_CLIENT) private readonly db: DynamoDBDocumentClient) {
    super();
  }

  async listAll(): Promise<PendingRow[]> {
    const items: PendingRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(
        new QueryCommand({
          TableName: CONTENT_TABLE_NAME,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': 'STATUS#pending' },
          ScanIndexForward: false,
          ExclusiveStartKey: lastKey,
        }),
      );
      items.push(
        ...((result.Items ?? []) as PendingRow[]).filter(hasPayload).map(sanitizePendingRow),
      );
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return items;
  }

  async get(thingId: string, sk: string): Promise<PendingRow | undefined> {
    const result = await this.db.send(
      new GetCommand({
        TableName: CONTENT_TABLE_NAME,
        Key: { PK: `THING#${thingId}`, SK: sk },
      }),
    );
    return result.Item ? sanitizePendingRow(result.Item as PendingRow) : undefined;
  }

  async insert(contribution: Contribution, thingId: string | undefined): Promise<void> {
    const targetThingId = thingId ?? contribution.id;
    const item: Record<string, unknown> = {
      ...contribution,
      PK: `THING#${targetThingId}`,
      SK: `CONTRIB#${contribution.createdAt}#${contribution.contributorId}`,
      GSI2PK: 'STATUS#pending',
      GSI2SK: `CONTRIB#${contribution.createdAt}`,
    };
    if (thingId === undefined) delete item.thingId;
    await this.db.send(new PutCommand({ TableName: CONTENT_TABLE_NAME, Item: item }));
  }

  async accumulate(
    existing: PendingRow,
    incoming: Contribution['payload'],
    thingId: string | undefined,
  ): Promise<void> {
    const pk = existing.PK ?? `THING#${existing.thingId ?? existing.id}`;
    const sk = existing.SK;
    if (!sk) {
      throw new Error('Pending contribution is missing SK');
    }
    const payload = mergeThingPayload(existing.payload, incoming);
    const linked = thingId ?? existing.thingId;
    await this.db.send(
      new UpdateCommand({
        TableName: CONTENT_TABLE_NAME,
        Key: { PK: pk, SK: sk },
        UpdateExpression: linked
          ? 'SET payload = :payload, thingId = :thingId'
          : 'SET payload = :payload',
        ExpressionAttributeValues: {
          ':payload': payload,
          ...(linked ? { ':thingId': linked } : {}),
        },
      }),
    );
  }

  async markApproved(rows: PendingRow[], reviewerId: string, now: string): Promise<void> {
    for (const row of rows) {
      if (!row.PK || !row.SK) continue;
      await this.db.send(
        new UpdateCommand({
          TableName: CONTENT_TABLE_NAME,
          Key: { PK: row.PK, SK: row.SK },
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
    }
  }
}

function hasPayload(item: Contribution | undefined): item is Contribution {
  return Boolean(item?.payload && typeof item.payload === 'object');
}

function sanitizePendingRow(row: PendingRow): PendingRow {
  return {
    ...row,
    id: typeof row.id === 'string' ? row.id : '',
    contributorId: typeof row.contributorId === 'string' ? row.contributorId : '',
    status: row.status === 'approved' || row.status === 'rejected' ? row.status : 'pending',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    payload: row.payload,
  };
}
