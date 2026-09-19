import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { CandidateDocument } from '../search/types.js';
import type { ExtractionResult, Taxonomy } from './types.js';

const SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'] as const;

function buildPrompt(document: CandidateDocument): string {
  return (
    `Web search results about a currently trending topic that may or may not be a pet hazard.\n\n` +
    `Topic: ${document.title}\n\n` +
    `Sources:\n${document.body}`
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
                      petTypeId: { type: 'string', enum: taxonomy.petTypeIds },
                      severity: { type: 'string', enum: [...SEVERITIES] },
                      summary: { type: 'string' },
                    },
                    required: ['isPetHazardReport'],
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
