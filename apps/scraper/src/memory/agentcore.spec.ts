import { describe, expect, it } from 'vitest';
import { mockAws } from '../test-utils.js';
import {
  BatchCreateMemoryRecordsCommand,
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreMemoryStore, recordText } from './agentcore.js';
import { SCRAPER_MEMORY_NAMESPACE } from './types.js';

function store(now = new Date('2026-10-03T15:00:00.000Z')) {
  return new AgentCoreMemoryStore({
    memoryId: 'mem-1',
    client: new BedrockAgentCoreClient({}),
    now: () => now,
  });
}

function summary(score: number, metadata: Record<string, string>, text = 'text') {
  return {
    memoryRecordId: `rec-${score}`,
    memoryStrategyId: undefined,
    namespaces: [SCRAPER_MEMORY_NAMESPACE],
    createdAt: new Date('2026-09-19T15:00:00.000Z'),
    content: { text },
    score,
    metadata: Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [key, { stringValue: value }]),
    ),
  };
}

describe('recordText', () => {
  it('leads with the term and the hazard name so a search for either finds the record', () => {
    expect(
      recordText({ term: 'birch sugar', name: 'Xylitol', outcome: 'filed', summary: 'Sweetener.' }),
    ).toBe('Researched topic: birch sugar. Hazard: Xylitol. Sweetener.');
    expect(recordText({ term: 'nfl', outcome: 'not_hazard', summary: 'No.' })).toBe(
      'Researched topic: nfl. No.',
    );
  });
});

describe('AgentCoreMemoryStore', () => {
  it('recalls one record per topic from its own namespace, best match first', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock.on(RetrieveMemoryRecordsCommand).resolves({
      memoryRecordSummaries: [
        summary(0.35, { term: 'grapes', outcome: 'filed' }),
        summary(0.47, { term: 'birch sugar', name: 'Xylitol', outcome: 'filed' }, 'Sweetener.'),
      ],
    });

    expect(await store().recall('xylitol', 3)).toEqual([
      {
        term: 'birch sugar',
        name: 'Xylitol',
        outcome: 'filed',
        summary: 'Sweetener.',
        score: 0.47,
      },
      { term: 'grapes', name: undefined, outcome: 'filed', summary: 'text', score: 0.35 },
    ]);
    expect(bedrock.commandCalls(RetrieveMemoryRecordsCommand)[0]?.args[0].input).toMatchObject({
      memoryId: 'mem-1',
      namespace: SCRAPER_MEMORY_NAMESPACE,
      maxResults: 3,
      searchCriteria: { searchQuery: 'xylitol', topK: 3 },
    });
  });

  it('ignores records that carry no term, such as the old merged summaries', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock.on(RetrieveMemoryRecordsCommand).resolves({
      memoryRecordSummaries: [
        summary(0.4, {}, 'The user has been researching toxic foods (chocolate, grapes, xylitol)'),
      ],
    });
    expect(await store().recall('xylitol', 3)).toEqual([]);
  });

  it('recalls nothing when retrieve fails, so a memory outage cannot block the run', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock.on(RetrieveMemoryRecordsCommand).rejects(new Error('throttled'));
    expect(await store().recall('xylitol', 3)).toEqual([]);
  });

  it('writes the record directly with its metadata, never as an event to be summarized', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock
      .on(BatchCreateMemoryRecordsCommand)
      .resolves({ successfulRecords: [], failedRecords: [] });
    const now = new Date('2026-10-03T15:00:00.000Z');

    await store(now).remember({
      term: 'birch sugar',
      name: 'Xylitol',
      outcome: 'filed',
      summary: 'Sweetener.',
    });

    const input = bedrock.commandCalls(BatchCreateMemoryRecordsCommand)[0]?.args[0].input;
    expect(input?.memoryId).toBe('mem-1');
    expect(input?.records).toHaveLength(1);
    expect(input?.records?.[0]).toMatchObject({
      namespaces: [SCRAPER_MEMORY_NAMESPACE],
      content: { text: 'Researched topic: birch sugar. Hazard: Xylitol. Sweetener.' },
      timestamp: now,
      metadata: {
        term: { stringValue: 'birch sugar' },
        name: { stringValue: 'Xylitol' },
        outcome: { stringValue: 'filed' },
      },
    });
    expect(bedrock.commandCalls(CreateEventCommand)).toHaveLength(0);
  });

  it('omits the name when the research named no hazard, and survives a write failure', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock.on(BatchCreateMemoryRecordsCommand).resolves({});
    await store().remember({ term: 'nfl scores', outcome: 'not_hazard', summary: 'No.' });
    const metadata = bedrock.commandCalls(BatchCreateMemoryRecordsCommand)[0]?.args[0].input
      .records?.[0]?.metadata;
    expect(metadata).toEqual({
      term: { stringValue: 'nfl scores' },
      outcome: { stringValue: 'not_hazard' },
    });

    bedrock.on(BatchCreateMemoryRecordsCommand).rejects(new Error('throttled'));
    await expect(
      store().remember({ term: 'x', outcome: 'no_hits', summary: 'No.' }),
    ).resolves.toBeUndefined();
  });
});
