import { describe, expect, it, vi } from 'vitest';
import { mockAws } from './test-utils.js';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
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
      petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
      confidence: 'high',
      summary: 'Sugar-free gum sweetener.',
    }),
    triage: async (_client, _model, terms) => terms,
    discover: async () => [],
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

  it('does not file a hazard report that has no name, but still marks the topic done', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({});
    db.on(ScanCommand).resolves({ Items: [] });
    db.on(QueryCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});
    const remember = vi.fn(async () => undefined);

    await run(
      config,
      client(),
      deps({
        memory: { alreadyCollected: async () => false, remember },
        classify: async () => ({
          isPetHazardReport: true,
          confidence: 'high',
          summary: 'Something vague.',
        }),
      }),
    );

    const items = db
      .commandCalls(PutCommand)
      .map(
        (call: { args: [{ input: { Item?: Record<string, unknown> } }] }) =>
          call.args[0].input.Item ?? {},
      );
    expect(
      items.some((i: Record<string, unknown>) => String(i.SK ?? '').startsWith('CONTRIB#')),
    ).toBe(false);
    expect(items.some((i: Record<string, unknown>) => i.PK === 'SCRAPERTREND#xylitol gum')).toBe(
      true,
    );
    expect(remember).toHaveBeenCalledWith('xylitol gum', expect.stringContaining('not filed'));
  });

  it('researches only triaged trends plus search-discovered hazards, and survives a Trends outage', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({});
    db.on(ScanCommand).resolves({ Items: [] });
    db.on(QueryCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});
    const searched: string[] = [];
    const search = {
      search: async (q: string) => {
        searched.push(q);
        return [{ title: 't', url: `https://example.com/${searched.length}`, text: 'x' }];
      },
    };

    await run(
      config,
      client(),
      deps({
        search,
        trends: {
          listTrendingTopics: async () => [{ term: 'nfl scores' }, { term: 'sago palm' }],
        },
        triage: async () => ['sago palm'],
        discover: async () => [{ term: 'Xylitol' }, { term: 'SAGO PALM' }],
      }),
    );
    // sago palm (once, de-duped case-insensitively) and xylitol; never "nfl scores".
    expect(searched.some((q) => q.includes('nfl scores'))).toBe(false);
    expect(searched.filter((q) => q.startsWith('sago palm')).length).toBeGreaterThan(0);
    expect(searched.some((q) => q.toLowerCase().startsWith('xylitol'))).toBe(true);

    searched.length = 0;
    await run(
      { ...config, maxTopicsPerRun: 8 },
      client(),
      deps({
        search,
        trends: {
          listTrendingTopics: async () => {
            throw new Error('Google Trends returned no trend rows');
          },
        },
        discover: async () => [{ term: 'grapes' }],
      }),
    );
    expect(searched.some((q) => q.startsWith('grapes'))).toBe(true);
  });

  it('caps research at N new topics, not N topics including ones already seen', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).callsFake((input: { Key: { PK: string } }) =>
      ['SCRAPERTREND#a', 'SCRAPERTREND#b'].includes(input.Key.PK)
        ? { Item: { PK: input.Key.PK } }
        : {},
    );
    db.on(ScanCommand).resolves({ Items: [] });
    db.on(QueryCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});
    const searched = new Set<string>();
    const search = {
      search: async (q: string) => {
        searched.add(q.split(' toxic')[0]!.split(' pet')[0]!);
        return [{ title: 't', url: `https://example.com/${q}`, text: 'x' }];
      },
    };
    await run(
      { ...config, maxTopicsPerRun: 2 },
      client(),
      deps({
        search,
        trends: { listTrendingTopics: async () => [] },
        discover: async () => ['a', 'b', 'c', 'd', 'e'].map((term) => ({ term })),
      }),
    );
    // a and b are already seen, so the two researched are c and d.
    expect([...searched].sort()).toEqual(['c', 'd']);
  });

  it('does not file a low-confidence report', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({});
    db.on(ScanCommand).resolves({ Items: [] });
    db.on(QueryCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});
    await run(
      config,
      client(),
      deps({
        classify: async () => ({
          isPetHazardReport: true,
          thingName: 'Xylitol',
          thingTypeId: 'food',
          confidence: 'low',
        }),
      }),
    );
    const items = db
      .commandCalls(PutCommand)
      .map(
        (call: { args: [{ input: { Item?: Record<string, unknown> } }] }) =>
          call.args[0].input.Item ?? {},
      );
    expect(
      items.some((i: Record<string, unknown>) => String(i.SK ?? '').startsWith('CONTRIB#')),
    ).toBe(false);
  });

  it('writes a pending contribution for a classified hazard and marks the topic', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({});
    db.on(ScanCommand).resolves({ Items: [] });
    db.on(QueryCommand).resolves({ Items: [] });
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
