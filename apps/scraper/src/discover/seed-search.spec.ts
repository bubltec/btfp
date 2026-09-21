import { describe, expect, it, vi } from 'vitest';
import { mockAws } from '../test-utils.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { discoverFromSearch } from './seed-search.js';

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
});
