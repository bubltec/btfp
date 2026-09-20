import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { mockAws } from '../test-utils.js';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { HydratingUsersService } from './hydrating-users.service.js';

const config = { usersTableName: 'btfp-dev-users', stage: 'dev' };

describe('HydratingUsersService.listAwaitingReview', () => {
  it('backfills id from PK so review is not called with undefined', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(ScanCommand).resolves({
      Items: [
        {
          PK: 'USER#email#someone@g-p.com',
          professional: {
            status: 'awaiting_review',
            domain: 'g-p.com',
            requestedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });
    db.on(UpdateCommand).resolves({});

    const users = new HydratingUsersService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      config as never,
    );
    const pending = await users.listAwaitingReview();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(pending[0]?.provider).toBe('email');
    expect(pending[0]?.providerAccountId).toBe('someone@g-p.com');
    expect(pending[0]?.displayName).toBe('g-p.com');
    expect(db.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues[':gsi']).toBe(
      `USERID#${pending[0]?.id}`,
    );
  });
});

describe('HydratingUsersService.reviewProfessional', () => {
  it('rejects a missing user id as 400, not a Dynamo lookup of "undefined"', async () => {
    const users = new HydratingUsersService(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      config as never,
    );
    await expect(users.reviewProfessional('undefined', true, 'reviewer')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
