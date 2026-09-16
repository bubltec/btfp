import { describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SCRAPER_CONTRIBUTOR_ID, writeContribution } from './contribution.js';
import type { RedditPost } from './reddit/types.js';
import type { ExtractionResult } from './extract/types.js';

const post: RedditPost = {
  id: 'abc123',
  title: 'title',
  selftext: 'body',
  permalink: '/r/dogs/comments/abc123/my_dog_ate_a_sock/',
  created_utc: 1700000000,
  stickied: false,
};

const extraction: ExtractionResult = {
  isPetHazardReport: true,
  thingName: 'Sock',
  thingTypeId: 'unknown',
  petTypeId: 'dog',
  severity: 'moderate',
  summary: 'Dog ate a sock, vomited it up fine.',
};

describe('writeContribution', () => {
  it("writes an item matching contributions.service.ts propose()'s exact key shape", async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      post,
      extraction,
    );

    expect(contribution.thingId).toBeUndefined();
    expect(contribution.contributorId).toBe(SCRAPER_CONTRIBUTOR_ID);
    expect(contribution.status).toBe('pending');

    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe(`THING#${contribution.id}`);
    expect(item.SK).toBe(`CONTRIB#${contribution.createdAt}#${SCRAPER_CONTRIBUTOR_ID}`);
    expect(item.GSI2PK).toBe('STATUS#pending');
    expect(item.GSI2SK).toBe(`CONTRIB#${contribution.createdAt}`);
    expect(item.thingId).toBeUndefined();
  });

  it('builds payload.sourceUrl from the real Reddit permalink and preserves severity/petType', async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      post,
      extraction,
    );

    expect(contribution.payload.source).toBe('reddit');
    expect(contribution.payload.sourceUrl).toBe(`https://reddit.com${post.permalink}`);
    expect(contribution.payload.petTypes).toEqual([{ petTypeId: 'dog', severity: 'moderate' }]);
    expect(contribution.payload.details).toMatchObject({ redditPostId: post.id });
  });

  it('defaults to an empty petTypes array when the extraction has no petTypeId', async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      post,
      { ...extraction, petTypeId: undefined },
    );

    expect(contribution.payload.petTypes).toEqual([]);
  });

  it('attaches to an existing Thing when the extracted name matches the catalog', async () => {
    const db = mockClient(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      post,
      { ...extraction, thingName: 'Chocolate', thingTypeId: 'food' },
      [
        {
          id: 'existing-chocolate',
          name: 'Chocolate / cocoa',
          thingTypeId: 'food',
          otherNames: [],
        },
      ],
    );

    expect(contribution.thingId).toBe('existing-chocolate');
    const item = db.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe('THING#existing-chocolate');
    expect(item.thingId).toBe('existing-chocolate');
  });
});
