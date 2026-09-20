import { describe, expect, it } from 'vitest';
import { mockAws } from './test-utils.js';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SCRAPER_CONTRIBUTOR_ID, isFileableExtraction, writeContribution } from './contribution.js';
import type { CandidateDocument } from './search/types.js';
import type { ExtractionResult } from './extract/types.js';

const document: CandidateDocument = {
  id: 'sock',
  title: 'sock',
  body: 'Dog ate a sock.',
  sourceUrl: 'https://example.com/sock',
  source: 'web-search',
  topic: 'sock',
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
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      document,
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

  it('preserves the search source URL, severity, and trend term', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      document,
      extraction,
    );

    expect(contribution.payload.source).toBe('web-search');
    expect(contribution.payload.sourceUrl).toBe(document.sourceUrl);
    expect(contribution.payload.petTypes).toEqual([{ petTypeId: 'dog', severity: 'moderate' }]);
    expect(contribution.payload.details).toMatchObject({ trendTerm: 'sock' });
  });

  it('defaults to an empty petTypes array when the extraction has no petTypeId', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      document,
      { ...extraction, petTypeId: undefined },
    );

    expect(contribution.payload.petTypes).toEqual([]);
  });

  it('attaches to an existing Thing when the extracted name matches the catalog', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });

    const contribution = await writeContribution(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      document,
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

describe('isFileableExtraction / nameless candidates', () => {
  it('needs both a name and a type', () => {
    expect(isFileableExtraction(extraction)).toBe(true);
    expect(isFileableExtraction({ ...extraction, thingName: undefined })).toBe(false);
    expect(isFileableExtraction({ ...extraction, thingName: '  ' })).toBe(false);
    expect(isFileableExtraction({ ...extraction, thingTypeId: undefined })).toBe(false);
  });

  it('refuses to write a nameless contribution', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(QueryCommand).resolves({ Items: [] });
    await expect(
      writeContribution(DynamoDBDocumentClient.from(new DynamoDBClient({})), document, {
        ...extraction,
        thingName: undefined,
      }),
    ).rejects.toThrow(/without a thing name/);
    expect(db.commandCalls(PutCommand)).toHaveLength(0);
  });
});
