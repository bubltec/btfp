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
  maxIdeasPerRun: 3,
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
    memory: { recall: async () => [], remember: async () => undefined },
    classify: async () => ({
      isPetHazardReport: true,
      thingName: 'Xylitol',
      thingTypeId: 'food',
      petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
      confidence: 'high',
      summary: 'Sugar-free gum sweetener.',
    }),
    triage: async (_client, _model, terms) => ({ relevant: terms, rejected: [] }),
    discover: async () => [],
    judge: async () => new Map(),
    ideate: async () => [],
    ...overrides,
  };
}

describe('run', () => {
  it('no-ops when the gateway URL is missing', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    await run({ ...config, agentCoreGatewayUrl: '' }, client(), deps());
    expect(db.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('skips a topic already marked, without asking triage about it again', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({ Item: { PK: 'SCRAPERTREND#xylitol gum' } });
    db.on(ScanCommand).resolves({ Items: [] });
    const search = vi.fn();
    const triage = vi.fn<ScraperDeps['triage']>(async () => ({ relevant: [], rejected: [] }));
    await run(config, client(), deps({ search: { search }, triage }));
    expect(search).not.toHaveBeenCalled();
    expect(triage.mock.calls[0]?.[2]).toEqual([]);
  });

  it('does not file a hazard report that has no name, but still marks the topic done', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({});
    db.on(ScanCommand).resolves({ Items: [] });
    db.on(QueryCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});
    const remember = vi.fn<ScraperDeps['memory']['remember']>(async () => undefined);

    await run(
      config,
      client(),
      deps({
        memory: { recall: async () => [], remember },
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
    expect(
      items.find((i: Record<string, unknown>) => i.PK === 'SCRAPERTREND#xylitol gum'),
    ).toMatchObject({ outcome: 'unusable' });
    expect(remember).toHaveBeenCalledWith({
      term: 'xylitol gum',
      name: undefined,
      outcome: 'unusable',
      summary: expect.stringContaining('not filed'),
    });
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
        triage: async () => ({ relevant: ['sago palm'], rejected: ['nfl scores'] }),
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

  describe('not paying twice', () => {
    const xylitol = {
      PK: 'THING#xylitol',
      SK: 'META',
      id: 'xylitol',
      name: 'Xylitol',
      thingTypeId: 'food',
      otherNames: ['Birch sugar'],
      petTypes: [{ petTypeId: 'dog', severity: 'severe' }],
    };

    function db(things: Record<string, unknown>[] = []) {
      const mock = mockAws(DynamoDBDocumentClient);
      mock.on(GetCommand).resolves({});
      mock
        .on(ScanCommand)
        .callsFake((input: { ExpressionAttributeValues: Record<string, string> }) => {
          const prefix =
            input.ExpressionAttributeValues[':prefix'] ??
            input.ExpressionAttributeValues[':thingPrefix'];
          if (prefix === 'PETTYPE#') return { Items: [{ id: 'dog', name: 'Dog' }] };
          if (prefix === 'THINGTYPE#') return { Items: [{ id: 'food', name: 'Food' }] };
          return { Items: things };
        });
      mock.on(QueryCommand).resolves({ Items: [] });
      mock.on(PutCommand).resolves({});
      return mock;
    }

    function markers(mock: ReturnType<typeof mockAws>): Record<string, unknown>[] {
      return mock
        .commandCalls(PutCommand)
        .map(
          (call: { args: [{ input: { Item?: Record<string, unknown> } }] }) =>
            call.args[0].input.Item ?? {},
        )
        .filter((item: Record<string, unknown>) => String(item.PK).startsWith('SCRAPERTREND#'));
    }

    it('remembers the trends triage ruled out, so they are not judged again', async () => {
      const mock = db();
      await run(
        config,
        client(),
        deps({
          trends: { listTrendingTopics: async () => [{ term: 'nfl scores' }, { term: 'weather' }] },
          // "weather" gets no verdict, so it stays open for the next run.
          triage: async () => ({ relevant: [], rejected: ['nfl scores'] }),
        }),
      );
      expect(markers(mock)).toEqual([
        expect.objectContaining({ PK: 'SCRAPERTREND#nfl scores', outcome: 'triaged_out' }),
      ]);
    });

    it('does not research a topic that is already a catalog entry, under its name or an alias', async () => {
      const mock = db([xylitol]);
      const search = vi.fn(async () => []);
      const recall = vi.fn<ScraperDeps['memory']['recall']>(async () => []);
      await run(
        config,
        client(),
        deps({
          trends: { listTrendingTopics: async () => [] },
          discover: async () => [{ term: 'xylitol' }, { term: 'Birch Sugar' }],
          search: { search },
          memory: { recall, remember: async () => undefined },
        }),
      );
      expect(search).not.toHaveBeenCalled();
      expect(recall).not.toHaveBeenCalledWith('xylitol', expect.anything());
      expect(markers(mock)).toEqual([
        expect.objectContaining({ PK: 'SCRAPERTREND#xylitol', outcome: 'in_catalog' }),
        expect.objectContaining({ PK: 'SCRAPERTREND#birch sugar', outcome: 'in_catalog' }),
      ]);
    });

    it('closes a topic memory shows was researched under another name, and says which', async () => {
      const mock = db();
      const searched: string[] = [];
      const judge = vi.fn<ScraperDeps['judge']>(async () => new Map([['Advil', 'ibuprofen']]));
      await run(
        config,
        client(),
        deps({
          trends: { listTrendingTopics: async () => [] },
          discover: async () => [{ term: 'Advil' }, { term: 'oleander' }],
          search: {
            search: async (q: string) => {
              searched.push(q);
              return [{ title: 't', url: `https://example.com/${searched.length}`, text: 'x' }];
            },
          },
          memory: {
            recall: async (query) =>
              query === 'Advil'
                ? [{ term: 'ibuprofen', outcome: 'filed', summary: '', score: 0.383 }]
                : [],
            remember: async () => undefined,
          },
          judge,
        }),
      );
      expect(judge).toHaveBeenCalledTimes(1);
      expect(searched.some((q) => q.startsWith('Advil'))).toBe(false);
      expect(searched.some((q) => q.startsWith('oleander'))).toBe(true);
      expect(markers(mock)).toContainEqual(
        expect.objectContaining({
          PK: 'SCRAPERTREND#advil',
          outcome: 'duplicate',
          duplicateOf: 'ibuprofen',
        }),
      );
    });

    it('remembers each researched topic with the hazard it turned out to be', async () => {
      db();
      const remember = vi.fn<ScraperDeps['memory']['remember']>(async () => undefined);
      await run(config, client(), deps({ memory: { recall: async () => [], remember } }));
      expect(remember).toHaveBeenCalledWith({
        term: 'xylitol gum',
        name: 'Xylitol',
        outcome: 'filed',
        summary: 'Sugar-free gum sweetener.',
      });
    });
  });

  describe('suggesting topics when discovery finds nothing new', () => {
    const lily = {
      PK: 'THING#lily',
      SK: 'META',
      id: 'lily',
      name: 'Lily',
      thingTypeId: 'plant',
      otherNames: [],
      petTypes: [{ petTypeId: 'cat', severity: 'severe' }],
    };

    function db() {
      const mock = mockAws(DynamoDBDocumentClient);
      mock.on(GetCommand).resolves({});
      mock
        .on(ScanCommand)
        .callsFake((input: { ExpressionAttributeValues: Record<string, string> }) => {
          const prefix =
            input.ExpressionAttributeValues[':prefix'] ??
            input.ExpressionAttributeValues[':thingPrefix'];
          if (prefix === 'PETTYPE#') return { Items: [{ id: 'cat', name: 'Cat' }] };
          if (prefix === 'THINGTYPE#') return { Items: [{ id: 'plant', name: 'Plant' }] };
          return { Items: [lily] };
        });
      mock.on(QueryCommand).resolves({ Items: [] });
      mock.on(PutCommand).resolves({});
      return mock;
    }

    const quiet = { trends: { listTrendingTopics: async () => [] } };

    it('asks for what the catalog and memory do not cover, and researches up to the idea budget', async () => {
      const mock = db();
      const searched: string[] = [];
      const ideate = vi.fn<ScraperDeps['ideate']>(async () => [
        'Oleander',
        'Lilies',
        'Foxglove',
        'Yew',
      ]);
      const recall = vi.fn<ScraperDeps['memory']['recall']>(async (query) =>
        query === 'Plant harmful to Cat'
          ? [
              {
                term: 'poinsettia',
                name: 'Poinsettia',
                outcome: 'not_hazard',
                summary: '',
                score: 0.4,
              },
            ]
          : [],
      );
      await run(
        { ...config, maxIdeasPerRun: 2 },
        client(),
        deps({
          ...quiet,
          ideate,
          memory: { recall, remember: async () => undefined },
          search: {
            search: async (q: string) => {
              searched.push(q);
              return [{ title: 't', url: `https://example.com/${searched.length}`, text: 'x' }];
            },
          },
        }),
      );

      expect(ideate.mock.calls[0]?.[2]).toEqual({
        focus: { thingTypeId: 'plant', petTypeId: 'cat' },
        thingTypeName: 'Plant',
        petTypeName: 'Cat',
        covered: ['Lily', 'poinsettia', 'Poinsettia'],
        count: 6,
      });
      // "Lilies" is the catalog's Lily; Oleander and Foxglove fill the two slots; Yew waits.
      const researched = (name: string) => searched.some((q) => q.startsWith(`${name} toxic`));
      expect(researched('Oleander')).toBe(true);
      expect(researched('Foxglove')).toBe(true);
      expect(researched('Lilies')).toBe(false);
      expect(researched('Yew')).toBe(false);
      const puts = mock
        .commandCalls(PutCommand)
        .map(
          (call: { args: [{ input: { Item?: Record<string, unknown> } }] }) =>
            call.args[0].input.Item ?? {},
        );
      expect(puts).toContainEqual(expect.objectContaining({ PK: 'SCRAPERIDEA#CURSOR', index: 0 }));
    });

    it('does not ask when discovery already filled the run', async () => {
      db();
      const ideate = vi.fn<ScraperDeps['ideate']>(async () => ['Oleander']);
      await run(
        { ...config, maxTopicsPerRun: 2 },
        client(),
        deps({ ...quiet, ideate, discover: async () => [{ term: 'yew' }, { term: 'foxglove' }] }),
      );
      expect(ideate).not.toHaveBeenCalled();
    });
  });

  describe('enriching existing entries', () => {
    const begonia = {
      PK: 'THING#begonia',
      SK: 'META',
      id: 'begonia',
      name: 'Elephant-Ear Begonia',
      thingTypeId: 'plant',
      otherNames: [],
      petTypes: [
        { petTypeId: 'dog', severity: 'unknown' },
        { petTypeId: 'cat', severity: 'unknown' },
      ],
    };

    function catalogDb(enrichedAt?: string) {
      const db = mockAws(DynamoDBDocumentClient);
      db.on(GetCommand).callsFake((input: { Key: { PK: string } }) =>
        input.Key.PK === 'SCRAPERENRICH#begonia' && enrichedAt
          ? { Item: { attemptedAt: enrichedAt } }
          : {},
      );
      db.on(ScanCommand).callsFake(
        (input: { ExpressionAttributeValues: Record<string, string> }) => {
          const prefix =
            input.ExpressionAttributeValues[':prefix'] ??
            input.ExpressionAttributeValues[':thingPrefix'];
          if (prefix === 'PETTYPE#') return { Items: [{ id: 'dog' }, { id: 'cat' }] };
          if (prefix === 'THINGTYPE#') return { Items: [{ id: 'plant' }] };
          return { Items: [begonia] };
        },
      );
      db.on(QueryCommand).resolves({ Items: [] });
      db.on(PutCommand).resolves({});
      return db;
    }

    function puts(db: ReturnType<typeof mockAws>): Record<string, unknown>[] {
      return db
        .commandCalls(PutCommand)
        .map(
          (call: { args: [{ input: { Item?: Record<string, unknown> } }] }) =>
            call.args[0].input.Item ?? {},
        );
    }

    it('spends unused budget on an unknown entry and files an update against it', async () => {
      const db = catalogDb();
      const searched: string[] = [];
      const classify = vi.fn<ScraperDeps['classify']>(async () => ({
        isPetHazardReport: true,
        thingName: 'Begonia',
        thingTypeId: 'plant',
        petTypes: [{ petTypeId: 'dog', severity: 'mild' }],
        confidence: 'high',
      }));
      await run(
        config,
        client(),
        deps({
          trends: { listTrendingTopics: async () => [] },
          search: {
            search: async (q: string) => {
              searched.push(q);
              return [{ title: 't', url: 'https://example.com/begonia', text: 'x' }];
            },
          },
          classify,
        }),
      );

      expect(searched).toContain('Elephant-Ear Begonia toxic to dogs');
      expect(classify.mock.calls[0]?.[2]).toMatchObject({ focusPetTypeIds: ['dog', 'cat'] });
      const items = puts(db);
      const contrib = items.find((i) => String(i.SK ?? '').startsWith('CONTRIB#'));
      // Filed against the existing entry under its own name, not the classifier's rename.
      expect(contrib).toMatchObject({ PK: 'THING#begonia', thingId: 'begonia' });
      expect(contrib?.payload).toMatchObject({ name: 'Elephant-Ear Begonia' });
      expect(items.find((i) => i.PK === 'SCRAPERENRICH#begonia')).toMatchObject({
        outcome: 'Update filed.',
      });
    });

    it('files nothing when the research adds no known severity, but records the attempt', async () => {
      const db = catalogDb();
      await run(
        config,
        client(),
        deps({
          trends: { listTrendingTopics: async () => [] },
          classify: async () => ({
            isPetHazardReport: true,
            thingName: 'Begonia',
            thingTypeId: 'plant',
            petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
            confidence: 'high',
          }),
        }),
      );
      const items = puts(db);
      expect(items.some((i) => String(i.SK ?? '').startsWith('CONTRIB#'))).toBe(false);
      expect(items.find((i) => i.PK === 'SCRAPERENRICH#begonia')).toMatchObject({
        outcome: 'No new severity found.',
      });
    });

    it('skips an entry researched within the retry window', async () => {
      const db = catalogDb(new Date().toISOString());
      const search = vi.fn(async () => []);
      await run(
        config,
        client(),
        deps({ trends: { listTrendingTopics: async () => [] }, search: { search } }),
      );
      expect(search).not.toHaveBeenCalled();
      expect(puts(db).some((i) => i.PK === 'SCRAPERENRICH#begonia')).toBe(false);
    });
  });
});
