import { describe, expect, it, vi } from 'vitest';
import { mockAws } from './test-utils.js';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { run, type ScraperDeps } from './run.js';
import type { ScraperConfig } from './config.js';
import { SCRAPER_CONTRIBUTOR_ID } from './contribution.js';

const config: ScraperConfig = {
  env: 'dev',
  region: 'us-east-1',
  bedrockInferenceProfileId: 'model-id',
  agentCoreGatewayUrl: 'https://gw.example/mcp',
  agentCoreMemoryId: 'mem-1',
  trendsGeo: 'US',
  trendsHours: 24,
  trendsCategory: 13,
  maxTopicsPerRun: 8,
  maxSearchResults: 5,
};

function client() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function deps(overrides: Partial<ScraperDeps> = {}): ScraperDeps {
  return {
    trends: { listTrendingTopics: async () => [{ term: 'xylitol gum' }] },
    search: {
      search: async () => [
        {
          title: 'Xylitol is toxic to dogs',
          url: 'https://example.com/xylitol',
          text: 'Even small amounts can cause liver failure.',
        },
      ],
    },
    memory: { alreadyCollected: async () => false, remember: async () => undefined },
    classify: async () => ({
      isPetHazardReport: true,
      thingName: 'Xylitol',
      thingTypeId: 'food',
      petTypeId: 'dog',
      severity: 'severe',
      summary: 'Sugar-free gum sweetener.',
    }),
    ...overrides,
  };
}

describe('run', () => {
  it('no-ops when the gateway URL is missing', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    await run({ ...config, agentCoreGatewayUrl: '' }, client(), deps());
    expect(db.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('skips a topic already marked or remembered', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({ Item: { PK: 'SCRAPERTREND#xylitol gum' } });
    const search = vi.fn();
    await run(config, client(), deps({ search: { search } }));
    expect(search).not.toHaveBeenCalled();
  });

  it('writes a pending contribution for a classified hazard and marks the topic', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({});
    db.on(ScanCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});

    await run(config, client(), deps());

    const puts = db
      .commandCalls(PutCommand)
      .map(
        (call: { args: [{ input: { Item?: Record<string, unknown> } }] }) =>
          call.args[0].input.Item ?? {},
      );
    expect(
      puts.some((item: Record<string, unknown>) => item.PK === 'SCRAPERTREND#xylitol gum'),
    ).toBe(true);
    const contrib = puts.find((item: Record<string, unknown>) =>
      String(item.SK ?? '').startsWith('CONTRIB#'),
    );
    expect(contrib?.contributorId).toBe(SCRAPER_CONTRIBUTOR_ID);
    expect(contrib?.GSI2PK).toBe('STATUS#pending');
    expect(contrib?.payload).toMatchObject({
      name: 'Xylitol',
      source: 'web-search',
      sourceUrl: 'https://example.com/xylitol',
    });
  });
});
