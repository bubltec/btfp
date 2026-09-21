import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { SearchClient } from '../search/types.js';
import type { TrendTopic } from '../trends/types.js';

/**
 * Queries aimed straight at hazard news and poison-control content. Trending Now surfaces
 * whatever is popular (mostly sports and news), so this is the source that finds toxic items.
 */
export const SEED_QUERIES = [
  'new toxic substance dogs veterinarians warn this week',
  'cats poisoned by common household item vet warning',
  'pet poison helpline trending toxin dogs cats',
  'pet food or treat recall illness dogs cats',
  'poisonous plant dogs cats emergency vet cases increasing',
];

const SYSTEM = [
  'From these web search results, list the specific substances, plants, foods, products or chemicals',
  'that the sources say are poisonous or harmful to dogs or cats.',
  'One short name each (for example "Xylitol", "Sago palm"). No categories, no brands unless a',
  'specific product is being recalled, no generic advice. Only names the sources actually mention.',
].join('\n');

export async function discoverFromSearch(
  search: SearchClient,
  client: BedrockRuntimeClient,
  modelId: string,
  opts: { seeds?: string[]; maxResults: number },
): Promise<TrendTopic[]> {
  const found = new Map<string, TrendTopic>();
  for (const query of opts.seeds ?? SEED_QUERIES) {
    let hits;
    try {
      hits = await search.search(query, opts.maxResults);
    } catch (err) {
      console.warn(`Seed search failed for "${query}": ${String(err)}`);
      continue;
    }
    if (hits.length === 0) continue;
    const text = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.text}`).join('\n\n');
    try {
      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: SYSTEM }],
          inferenceConfig: { temperature: 0, maxTokens: 512 },
          messages: [{ role: 'user', content: [{ text: text.slice(0, 12_000) }] }],
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: 'list_hazards',
                  description: 'The named hazards mentioned in the sources.',
                  inputSchema: {
                    json: {
                      type: 'object',
                      properties: { names: { type: 'array', items: { type: 'string' } } },
                      required: ['names'],
                    },
                  },
                },
              },
            ],
            toolChoice: { tool: { name: 'list_hazards' } },
          },
        }),
      );
      const input = response.output?.message?.content?.find((b) => b.toolUse)?.toolUse?.input as
        | { names?: string[] }
        | undefined;
      for (const raw of input?.names ?? []) {
        const term = String(raw).trim();
        if (term.length < 2 || term.length > 80) continue;
        const key = term.toLowerCase();
        if (!found.has(key)) found.set(key, { term });
      }
    } catch (err) {
      console.warn(`Hazard extraction failed for "${query}": ${String(err)}`);
    }
  }
  return [...found.values()];
}
