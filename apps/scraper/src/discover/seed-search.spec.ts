import { describe, expect, it, vi } from 'vitest';
import { mockAws } from '../test-utils.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { discoverFromSearch } from './seed-search.js';
import type { SeedState } from './seed-state.js';

describe('discoverFromSearch', () => {
  it('extracts hazard names per seed query, de-duplicated, skipping failures', async () => {
    const bedrock = mockAws(BedrockRuntimeClient);
    bedrock
      .on(ConverseCommand)
      .resolvesOnce({
        output: {
          message: {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  toolUseId: 't',
                  name: 'list_hazards',
                  input: { names: ['Xylitol', ' '] },
                },
              },
            ],
          },
        },
      })
      .resolves({
        output: {
          message: {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  toolUseId: 't',
                  name: 'list_hazards',
                  input: { names: ['xylitol', 'Sago palm'] },
                },
              },
            ],
          },
        },
      });
    const search = {
      search: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue([{ title: 't', url: 'u', text: 'x' }]),
    };
    const topics = await discoverFromSearch(search, new BedrockRuntimeClient({}), 'm', {
      seeds: ['q1', 'q2', 'q3'],
      maxResults: 5,
    });
    expect(topics.map((t) => t.term)).toEqual(['Xylitol', 'Sago palm']);
    expect(search.search).toHaveBeenCalledTimes(3);
  });

  it('skips extraction for a query that returned the same pages, and skips a query backing off', async () => {
    const bedrock = mockAws(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [
            { toolUse: { toolUseId: 't', name: 'list_hazards', input: { names: ['Lilies'] } } },
          ],
        },
      },
    });
    const now = new Date('2026-09-27T00:00:00Z');
    const states = new Map<string, SeedState>([
      ['same', { knownUrls: ['u1'], staleRuns: 0 }],
      ['waiting', { knownUrls: [], staleRuns: 2, nextSearchAt: '2026-09-28T00:00:00Z' }],
    ]);
    const seedState = {
      get: async (q: string) => states.get(q),
      put: async (q: string, s: SeedState) => void states.set(q, s),
    };
    const search = { search: vi.fn(async (_q: string) => [{ title: 't', url: 'u1', text: 'x' }]) };

    const topics = await discoverFromSearch(search, new BedrockRuntimeClient({}), 'm', {
      seeds: ['same', 'waiting', 'new'],
      maxResults: 5,
      seedState,
      now,
    });

    expect(search.search.mock.calls.map((c) => c[0])).toEqual(['same', 'new']);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
    expect(topics.map((t) => t.term)).toEqual(['Lilies']);
    expect(states.get('same')).toMatchObject({
      staleRuns: 1,
      nextSearchAt: '2026-09-27T12:00:00.000Z',
    });
  });
});
