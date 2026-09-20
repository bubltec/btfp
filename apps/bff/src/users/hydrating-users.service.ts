import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ScanCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '@bubltec/mycota-dynamo';
import {
  MYCOTA_AUTH_CONFIG,
  UsersService,
  type MycotaAuthConfig,
  type User,
} from '@bubltec/mycota-auth';

/**
 * mycota's listAwaitingReview strips PK/GSI1PK. Legacy / UpdateCommand-created
 * rows can lack `id`, so review then looks up USERID#undefined. Sanitize at
 * the read boundary (same Scan mycota already uses for this small table) and
 * backfill identity so the mycota review path can resolve the user.
 */
@Injectable()
export class HydratingUsersService extends UsersService {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    @Inject(MYCOTA_AUTH_CONFIG) private readonly authConfig: MycotaAuthConfig,
  ) {
    super(doc, authConfig);
  }

  override async listAwaitingReview(): Promise<User[]> {
    const items = await this.scanAwaiting();
    return Promise.all(items.map((item) => this.hydrate(item)));
  }

  override async reviewProfessional(
    id: string,
    approve: boolean,
    reviewerId: string,
    reason?: string,
  ): Promise<User> {
    if (!id?.trim() || id === 'undefined') {
      throw new BadRequestException('User id is required');
    }
    const existing = await this.getById(id);
    if (existing) {
      return super.reviewProfessional(id, approve, reviewerId, reason);
    }
    const match = (await this.scanAwaiting()).find(
      (item) => item.id === id || item.GSI1PK === `USERID#${id}`,
    );
    if (!match) throw new NotFoundException(`No user with id ${id}`);
    const user = await this.hydrate(match);
    return super.reviewProfessional(user.id, approve, reviewerId, reason);
  }

  private async scanAwaiting(): Promise<Record<string, unknown>[]> {
    const result = await this.doc.send(
      new ScanCommand({
        TableName: this.authConfig.usersTableName,
        FilterExpression: 'professional.#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'awaiting_review' },
      }),
    );
    return (result.Items ?? []) as Record<string, unknown>[];
  }

  private async hydrate(item: Record<string, unknown>): Promise<User> {
    const parsed = parseUserPk(typeof item.PK === 'string' ? item.PK : '');
    const fromGsi =
      typeof item.GSI1PK === 'string' && item.GSI1PK.startsWith('USERID#')
        ? item.GSI1PK.slice('USERID#'.length)
        : undefined;
    const id = (typeof item.id === 'string' && item.id.trim()) || fromGsi || randomUUID();
    const provider =
      (typeof item.provider === 'string' && item.provider) || parsed?.provider || 'email';
    const providerAccountId =
      (typeof item.providerAccountId === 'string' && item.providerAccountId) ||
      parsed?.providerAccountId ||
      id;
    const professional = isProfessional(item.professional) ? item.professional : undefined;
    const displayName =
      (typeof item.displayName === 'string' && item.displayName) ||
      professional?.domain ||
      providerAccountId;

    if (item.PK && (!item.id || !item.GSI1PK || !item.provider || !item.displayName)) {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.authConfig.usersTableName,
          Key: { PK: item.PK },
          UpdateExpression:
            'SET id = :id, GSI1PK = :gsi, #provider = :provider, providerAccountId = :paid, displayName = :name',
          ExpressionAttributeNames: { '#provider': 'provider' },
          ExpressionAttributeValues: {
            ':id': id,
            ':gsi': `USERID#${id}`,
            ':provider': provider,
            ':paid': providerAccountId,
            ':name': displayName,
          },
        }),
      );
    }

    return {
      id,
      provider: provider as User['provider'],
      providerAccountId,
      displayName,
      verifiedContributor: item.verifiedContributor === true,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      email: typeof item.email === 'string' ? item.email : undefined,
      avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : undefined,
      verifiedAt: typeof item.verifiedAt === 'string' ? item.verifiedAt : undefined,
      professional,
    };
  }
}

function isProfessional(value: unknown): value is NonNullable<User['professional']> {
  return Boolean(value && typeof value === 'object' && 'status' in value && 'domain' in value);
}

function parseUserPk(pk: string): { provider: string; providerAccountId: string } | undefined {
  const match = /^USER#([^#]+)#(.+)$/.exec(pk);
  if (!match) return undefined;
  return { provider: match[1]!, providerAccountId: match[2]! };
}
