import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const SYSTEM = [
  'You screen trending search topics for a pet-safety catalog.',
  'Give a verdict for every topic. couldHarmDogOrCat is true only for topics that name something a dog or cat could eat, chew, lick, touch or be',
  'exposed to and be poisoned or harmed by: a food, plant, medication, product, chemical, or an',
  'activity or object. Exclude sports, news, people, entertainment, places, and generic pet topics',
  '(breeds, adoption, pet names). When unsure, exclude.',
].join('\n');

export interface TriageResult {
  /** Terms worth researching. */
  relevant: string[];
  /** Terms the model explicitly ruled out. Safe to remember, so they are not judged again. */
  rejected: string[];
}

/**
 * Sorts trending terms into worth researching and not. Fails closed: any error keeps nothing,
 * and rejects nothing either, so an outage does not permanently rule a term out.
 */
export async function triageTopics(
  client: BedrockRuntimeClient,
  modelId: string,
  terms: string[],
): Promise<TriageResult> {
  if (terms.length === 0) return { relevant: [], rejected: [] };
  try {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM }],
        inferenceConfig: { temperature: 0, maxTokens: 512 },
        messages: [
          {
            role: 'user',
            content: [{ text: `Trending topics:\n${terms.map((t) => `- ${t}`).join('\n')}` }],
          },
        ],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'judge_topics',
                description: 'A verdict for every topic, in the order given.',
                inputSchema: {
                  json: {
                    type: 'object',
                    properties: {
                      decisions: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            topic: { type: 'string' },
                            reason: { type: 'string' },
                            couldHarmDogOrCat: { type: 'boolean' },
                          },
                          required: ['topic', 'reason', 'couldHarmDogOrCat'],
                        },
                      },
                    },
                    required: ['decisions'],
                  },
                },
              },
            },
          ],
          toolChoice: { tool: { name: 'judge_topics' } },
        },
      }),
    );
    const input = response.output?.message?.content?.find((b) => b.toolUse)?.toolUse?.input as
      | { decisions?: { topic?: string; couldHarmDogOrCat?: boolean }[] }
      | undefined;
    const allowed = new Set(terms.map((t) => t.toLowerCase()));
    // Only accept terms we sent, so the model cannot introduce new topics here.
    const decisions = (input?.decisions ?? []).filter((d) =>
      allowed.has(String(d.topic).toLowerCase()),
    );
    return {
      relevant: decisions.filter((d) => d.couldHarmDogOrCat === true).map((d) => String(d.topic)),
      rejected: decisions.filter((d) => d.couldHarmDogOrCat === false).map((d) => String(d.topic)),
    };
  } catch {
    return { relevant: [], rejected: [] };
  }
}
