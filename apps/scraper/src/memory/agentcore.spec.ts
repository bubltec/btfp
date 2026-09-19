import { describe, expect, it } from 'vitest';
import { mockAws } from '../test-utils.js';
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreMemoryStore, recordLooksLikeTopic } from './agentcore.js';
import { SCRAPER_MEMORY_ACTOR_ID, SCRAPER_MEMORY_NAMESPACE } from './types.js';

describe('recordLooksLikeTopic', () => {
  it('matches case-insensitively', () => {
    expect(recordLooksLikeTopic('Collected research for Xylitol gum', 'xylitol gum')).toBe(true);
    expect(recordLooksLikeTopic('unrelated onions', 'xylitol')).toBe(false);
  });
});

describe('AgentCoreMemoryStore', () => {
  it('retrieves in the scraper namespace and treats a matching record as collected', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock.on(RetrieveMemoryRecordsCommand).resolves({
      memoryRecordSummaries: [
        {
          memoryRecordId: 'rec-1',
          memoryStrategyId: 'strat-1',
          namespaces: ['/scraper/btfp-scraper'],
          createdAt: new Date('2026-09-19T15:00:00.000Z'),
          content: { text: 'Collected pet-hazard research for trending topic "xylitol".' },
        },
      ],
    });

    const store = new AgentCoreMemoryStore({
      memoryId: 'mem-1',
      client: new BedrockAgentCoreClient({}),
    });
    expect(await store.alreadyCollected('xylitol')).toBe(true);

    const input = bedrock.commandCalls(RetrieveMemoryRecordsCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      memoryId: 'mem-1',
      namespace: SCRAPER_MEMORY_NAMESPACE,
      searchCriteria: { searchQuery: 'xylitol', topK: 5 },
    });
  });

  it('returns false when retrieve fails so a memory outage cannot block the run', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock.on(RetrieveMemoryRecordsCommand).rejects(new Error('throttled'));

    const store = new AgentCoreMemoryStore({
      memoryId: 'mem-1',
      client: new BedrockAgentCoreClient({}),
    });
    expect(await store.alreadyCollected('xylitol')).toBe(false);
  });

  it('writes a conversational event for later extraction', async () => {
    const bedrock = mockAws(BedrockAgentCoreClient);
    bedrock.on(CreateEventCommand).resolves({});
    const now = new Date('2026-09-19T15:00:00.000Z');

    const store = new AgentCoreMemoryStore({
      memoryId: 'mem-1',
      client: new BedrockAgentCoreClient({}),
      now: () => now,
    });
    await store.remember('xylitol', 'Hazard candidate: Xylitol.');

    const input = bedrock.commandCalls(CreateEventCommand)[0]?.args[0].input;
    expect(input?.memoryId).toBe('mem-1');
    expect(input?.actorId).toBe(SCRAPER_MEMORY_ACTOR_ID);
    expect(input?.payload?.[0]?.conversational?.content?.text).toContain('xylitol');
  });
});
