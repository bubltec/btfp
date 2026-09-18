import { describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Thing } from '@btfp/shared-types';
import { looksLikeComboName, reviewCatalog, reviewComboCandidate } from './review-similar.js';

function thing(overrides: Partial<Thing> & Pick<Thing, 'id' | 'name' | 'thingTypeId'>): Thing {
  return {
    otherNames: [],
    petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
    details: {},
    source: 'test',
    verified: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('looksLikeComboName', () => {
  it('flags comma-separated lists', () => {
    expect(looksLikeComboName('Onions, garlic, leeks, chives, shallots (Allium spp.)')).toBe(true);
  });

  it('flags "X and Y" style names', () => {
    expect(looksLikeComboName('Onions, Garlic and Chives')).toBe(true);
    expect(looksLikeComboName('Ibuprofen & Naproxen')).toBe(true);
  });

  it('does not flag ordinary single-item names', () => {
    expect(looksLikeComboName('Garlic')).toBe(false);
    expect(looksLikeComboName('Shallot')).toBe(false);
  });

  it('flags slash-separated lists too, even though not every match is a real split', () => {
    // Intentionally over-selects — "Grapes / raisins / currants / sultanas" is a
    // real combo, but "Chocolate / cocoa" (same substance, not a list of
    // distinct items) also matches. That's fine: this is a pre-filter for a
    // human/Bedrock review step, not the final split decision.
    expect(looksLikeComboName('Grapes / raisins / currants / sultanas')).toBe(true);
    expect(looksLikeComboName('Chocolate / cocoa')).toBe(true);
  });
});

describe('reviewComboCandidate', () => {
  it('sends a forced tool-use request and parses the result', async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 't1',
                name: 'review_combo_entry',
                input: {
                  isComboEntry: true,
                  members: [{ name: 'Onion', scientificName: 'Allium cepa' }, { name: 'Garlic' }],
                  overlapsExisting: ['Garlic'],
                  reasoning:
                    'Bundles five distinct species; garlic is more potent than the others.',
                },
              },
            },
          ],
        },
      },
    });

    const client = new BedrockRuntimeClient({});
    const candidate = thing({
      id: 'combo',
      name: 'Onions, garlic, leeks, chives, shallots (Allium spp.)',
      thingTypeId: 'food',
    });
    const result = await reviewComboCandidate(client, 'model-id', candidate, ['Garlic']);

    expect(result?.isComboEntry).toBe(true);
    expect(result?.members).toHaveLength(2);
    expect(result?.overlapsExisting).toEqual(['Garlic']);

    const call = bedrock.commandCalls(ConverseCommand)[0];
    expect(call?.args[0].input.modelId).toBe('model-id');
    expect(call?.args[0].input.toolConfig?.toolChoice).toEqual({
      tool: { name: 'review_combo_entry' },
    });
  });

  it('returns null when the response has no tool-use block', async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock
      .on(ConverseCommand)
      .resolves({ output: { message: { role: 'assistant', content: [] } } });

    const client = new BedrockRuntimeClient({});
    const candidate = thing({ id: 'x', name: 'X and Y', thingTypeId: 'food' });
    expect(await reviewComboCandidate(client, 'model-id', candidate, [])).toBeNull();
  });

  it('returns null instead of throwing when the Bedrock call fails', async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).rejects(new Error('throttled'));

    const client = new BedrockRuntimeClient({});
    const candidate = thing({ id: 'x', name: 'X and Y', thingTypeId: 'food' });
    expect(await reviewComboCandidate(client, 'model-id', candidate, [])).toBeNull();
  });
});

describe('reviewCatalog', () => {
  it('only calls Bedrock for combo-looking names, and only keeps flagged combos', async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 't1',
                name: 'review_combo_entry',
                input: {
                  isComboEntry: true,
                  members: [{ name: 'Onion' }, { name: 'Garlic' }],
                  overlapsExisting: [],
                  reasoning: 'combo',
                },
              },
            },
          ],
        },
      },
    });

    const things: Thing[] = [
      thing({ id: '1', name: 'Onions, Garlic and Chives', thingTypeId: 'food' }),
      thing({ id: '2', name: 'Chocolate', thingTypeId: 'food' }),
    ];

    const client = new BedrockRuntimeClient({});
    const flagged = await reviewCatalog(client, 'model-id', things);

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.thing.id).toBe('1');
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
  });
});
