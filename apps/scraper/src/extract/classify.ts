import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { CandidateDocument } from '../search/types.js';
import type { ExtractionResult, Taxonomy } from './types.js';

const SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;

export const CLASSIFY_SYSTEM_PROMPT = [
  'You are a veterinary-toxicology research assistant for a pet-safety catalog.',
  'You are given web search results about ONE candidate substance, plant, food, product or activity.',
  'Decide whether the sources show it is a real hazard to dogs or cats, and extract a catalog entry.',
  '',
  'Rules:',
  '- Use only what the sources say. Never fill gaps from memory; say "unknown" instead.',
  '- thingName is the single specific hazard (for example "Xylitol", "Sago palm"). Never a list, a',
  '  category ("common pet toxins"), a brand campaign, or the search phrase itself.',
  '- If the sources cover several distinct hazards, pick the one matching the candidate topic; if',
  '  none match, set isPetHazardReport to false.',
  '- petTypes: one entry per pet type (dog, cat, ...) the sources actually discuss, each with its own',
  '  severity. Omit a pet type the sources do not cover.',
  '- confidence: "high" only when two or more independent sources (veterinary, poison-control or',
  '  university pages) agree; "medium" for one solid source; "low" for forums, ads or vague claims.',
  '- summary: two or three sentences: what it is, why it is dangerous, and typical signs. No advice',
  '  to treat at home.',
  '- Marketing pages, news about unrelated topics and sources that only mention pets in passing are',
  '  not hazard reports.',
].join('\n');

function buildPrompt(document: CandidateDocument): string {
  return (
    `Candidate topic: ${document.title}\n\n` +
    `Search results (numbered; cite nothing that is not here):\n${document.body}`
  );
}

/**
 * A signal for the human moderator, not a gate — every extraction lands as
 * an unverified Contribution regardless of confidence; nothing here ever
 * writes a verified Thing directly. If Bedrock is unavailable or the
 * response is malformed, returns null so the caller just skips the topic
 * rather than blocking the whole run.
 */
export async function classifyDocument(
  client: BedrockRuntimeClient,
  modelId: string,
  document: CandidateDocument,
  taxonomy: Taxonomy,
): Promise<ExtractionResult | null> {
  try {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: CLASSIFY_SYSTEM_PROMPT }],
        inferenceConfig: { temperature: 0, maxTokens: 1024 },
        messages: [{ role: 'user', content: [{ text: buildPrompt(document) }] }],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'extract_pet_hazard',
                description:
                  'Determine whether these sources describe a real pet hazard and extract structured details if so.',
                inputSchema: {
                  json: {
                    type: 'object',
                    properties: {
                      isPetHazardReport: { type: 'boolean' },
                      thingName: { type: 'string' },
                      thingTypeId: { type: 'string', enum: taxonomy.thingTypeIds },
                      petTypes: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            petTypeId: { type: 'string', enum: taxonomy.petTypeIds },
                            severity: { type: 'string', enum: [...SEVERITIES] },
                          },
                          required: ['petTypeId', 'severity'],
                        },
                      },
                      summary: { type: 'string' },
                      confidence: { type: 'string', enum: [...CONFIDENCES] },
                    },
                    required: ['isPetHazardReport', 'confidence'],
                  },
                },
              },
            },
          ],
          toolChoice: { tool: { name: 'extract_pet_hazard' } },
        },
      }),
    );

    const toolUse = response.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
    const input = toolUse?.input as ExtractionResult | undefined;
    if (!input || typeof input.isPetHazardReport !== 'boolean') return null;

    return input;
  } catch {
    return null;
  }
}
