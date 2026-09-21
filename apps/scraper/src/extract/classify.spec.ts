import { describe, expect, it } from 'vitest';
import { mockAws } from '../test-utils.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { classifyDocument } from './classify.js';
import type { CandidateDocument } from '../search/types.js';
import type { Taxonomy } from './types.js';

const document: CandidateDocument = {
  id: 'xylitol-gum',
  title: 'xylitol gum',
  body: '[1] Xylitol is toxic\nhttps://example.com\nDogs can die from small amounts.',
  sourceUrl: 'https://example.com',
  source: 'web-search',
  topic: 'xylitol gum',
};

const taxonomy: Taxonomy = {
  thingTypeIds: ['plant', 'food', 'medication', 'unknown'],
  petTypeIds: ['dog', 'cat'],
};

describe('classifyDocument', () => {
  it('sends a forced tool-use request scoped to the live taxonomy enums', async () => {
    const bedrock = mockAws(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 't1',
                name: 'extract_pet_hazard',
                input: { isPetHazardReport: true, thingName: 'xylitol', confidence: 'high' },
              },
            },
          ],
        },
      },
    });

    const client = new BedrockRuntimeClient({});
    const result = await classifyDocument(client, 'model-id', document, taxonomy);

    expect(result).toEqual({ isPetHazardReport: true, thingName: 'xylitol', confidence: 'high' });

    const call = bedrock.commandCalls(ConverseCommand)[0];
    const sent = call?.args[0].input;
    expect(sent?.modelId).toBe('model-id');
    expect(sent?.toolConfig?.toolChoice).toEqual({ tool: { name: 'extract_pet_hazard' } });
    const tool = sent?.toolConfig?.tools?.[0]?.toolSpec;
    const schema = tool?.inputSchema?.json as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.thingTypeId?.enum).toEqual(taxonomy.thingTypeIds);
    const petItem = (
      schema.properties.petTypes as unknown as {
        items: { properties: { petTypeId: { enum: string[] } } };
      }
    ).items;
    expect(petItem.properties.petTypeId.enum).toEqual(taxonomy.petTypeIds);
    expect(sent?.system?.[0]?.text).toContain('Never fill gaps from memory');
  });

  it('returns null when the response has no tool-use block', async () => {
    const bedrock = mockAws(BedrockRuntimeClient);
    bedrock
      .on(ConverseCommand)
      .resolves({ output: { message: { role: 'assistant', content: [] } } });

    const client = new BedrockRuntimeClient({});
    expect(await classifyDocument(client, 'model-id', document, taxonomy)).toBeNull();
  });

  it('returns null instead of throwing when the Bedrock call fails', async () => {
    const bedrock = mockAws(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).rejects(new Error('throttled'));

    const client = new BedrockRuntimeClient({});
    expect(await classifyDocument(client, 'model-id', document, taxonomy)).toBeNull();
  });
});
