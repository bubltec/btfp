import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { normalizedPrimaryName } from '@btfp/shared-types';
import type { MemoryStore, RecalledResearch } from './memory/types.js';

/**
 * Below this, a recalled record is unrelated and the topic is new without asking anyone.
 *
 * Measured on 2026-10-03 against one-record-per-topic memory: unrelated pairs scored 0.33–0.36
 * ("chocolate"→xylitol 0.358, "naproxen"→ibuprofen 0.357), the same thing under another name
 * 0.37–0.54 ("Advil"→ibuprofen 0.383, "birch sugar"→xylitol 0.399, "sago palms"→sago palm
 * 0.540). "tea"→tea tree oil scored 0.379, inside that range, so a score alone cannot say
 * "duplicate": anything at or above the floor goes to the judge with the records it matched.
 */
export const SIMILARITY_FLOOR = 0.37;

/** Records recalled per topic. The duplicate, when there is one, is the top hit or close to it. */
const RECALL_LIMIT = 3;

export interface AmbiguousTopic {
  term: string;
  similar: RecalledResearch[];
}

export interface NoveltyVerdict {
  term: string;
  /** The earlier topic this one repeats. Absent when the topic is new. */
  duplicateOf?: string;
}

/** Maps a candidate term to the earlier term it repeats. Terms it leaves out are new. */
export type DuplicateJudge = (
  client: BedrockRuntimeClient,
  modelId: string,
  topics: AmbiguousTopic[],
) => Promise<Map<string, string>>;

const SYSTEM = [
  'You decide whether candidate research topics for a pet-safety catalog were already researched.',
  'Each candidate comes with the most similar topics researched before.',
  'sameAs is an earlier topic only when both name the same specific substance, plant, food,',
  'product or activity: a synonym, a brand name and its generic, a scientific and a common name,',
  'or a plural or packaging variant (for example "birch sugar" and "xylitol", "Advil" and',
  '"ibuprofen", "sago palms" and "sago palm").',
  'Related but different things are not the same: another drug in the same class, another species,',
  'or something that only contains or resembles it (for example "naproxen" and "ibuprofen", "tea"',
  'and "tea tree oil", "tiger lily" and "Easter lily"). When unsure, use null: researching a topic',
  'twice costs little, skipping a new hazard loses it.',
].join('\n');

/**
 * Sorts topics into new and already-researched using what memory holds about earlier research.
 * A recalled record with the same normalized term or hazard name is a duplicate outright. A
 * topic with nothing similar is new. Only what is left costs a model call, one for all of them.
 */
export async function assessNovelty(
  memory: MemoryStore,
  judge: DuplicateJudge,
  client: BedrockRuntimeClient,
  modelId: string,
  terms: string[],
): Promise<NoveltyVerdict[]> {
  const verdicts = new Map<string, NoveltyVerdict>();
  const ambiguous: AmbiguousTopic[] = [];

  for (const term of terms) {
    const recalled = await memory.recall(term, RECALL_LIMIT);
    const key = normalizedPrimaryName(term);
    const exact = recalled.find(
      (record) =>
        normalizedPrimaryName(record.term) === key ||
        (record.name !== undefined && normalizedPrimaryName(record.name) === key),
    );
    if (exact) {
      verdicts.set(term, { term, duplicateOf: exact.term });
      continue;
    }
    const similar = recalled.filter((record) => record.score >= SIMILARITY_FLOOR);
    if (similar.length > 0) ambiguous.push({ term, similar });
    verdicts.set(term, { term });
  }

  if (ambiguous.length > 0) {
    const duplicates = await judge(client, modelId, ambiguous);
    for (const [term, duplicateOf] of duplicates) verdicts.set(term, { term, duplicateOf });
  }
  return terms.map((term) => verdicts.get(term) ?? { term });
}

function describe(topic: AmbiguousTopic): string {
  const earlier = topic.similar
    .map((record) => {
      const name = record.name ? `hazard: ${record.name}; ` : '';
      return `- ${record.term} (${name}outcome: ${record.outcome})`;
    })
    .join('\n');
  return `Candidate: ${topic.term}\nEarlier topics:\n${earlier}`;
}

/** Fails open: any error or malformed answer leaves every topic new, so nothing is lost. */
export const judgeDuplicates: DuplicateJudge = async (client, modelId, topics) => {
  const duplicates = new Map<string, string>();
  if (topics.length === 0) return duplicates;
  try {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM }],
        inferenceConfig: { temperature: 0, maxTokens: 1024 },
        messages: [{ role: 'user', content: [{ text: topics.map(describe).join('\n\n') }] }],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'judge_duplicates',
                description: 'A decision for every candidate, in the order given.',
                inputSchema: {
                  json: {
                    type: 'object',
                    properties: {
                      decisions: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            candidate: { type: 'string' },
                            sameAs: {
                              type: ['string', 'null'],
                              description:
                                'The earlier topic it repeats, exactly as listed, or null.',
                            },
                          },
                          required: ['candidate', 'sameAs'],
                        },
                      },
                    },
                    required: ['decisions'],
                  },
                },
              },
            },
          ],
          toolChoice: { tool: { name: 'judge_duplicates' } },
        },
      }),
    );
    const input = response.output?.message?.content?.find((b) => b.toolUse)?.toolUse?.input as
      | { decisions?: { candidate?: unknown; sameAs?: unknown }[] }
      | undefined;
    const byTerm = new Map(topics.map((topic) => [topic.term.toLowerCase(), topic]));
    for (const decision of input?.decisions ?? []) {
      if (typeof decision.sameAs !== 'string') continue;
      const topic = byTerm.get(String(decision.candidate).toLowerCase());
      // Only an earlier topic we actually showed for this candidate counts.
      const sameAs = decision.sameAs.toLowerCase();
      const earlier = topic?.similar.find(
        (record) => record.term.toLowerCase() === sameAs || record.name?.toLowerCase() === sameAs,
      );
      if (topic && earlier) duplicates.set(topic.term, earlier.term);
    }
  } catch (err) {
    console.warn(`Duplicate check failed, treating ${topics.length} topics as new: ${String(err)}`);
    return new Map();
  }
  return duplicates;
};
