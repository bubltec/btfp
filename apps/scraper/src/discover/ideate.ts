import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONTENT_TABLE_NAME } from '../dynamo.js';
import type { Taxonomy } from '../extract/types.js';

/** One corner of the catalog to look for gaps in, for example plants and cats. */
export interface IdeationFocus {
  thingTypeId: string;
  petTypeId: string;
}

/** Names sent as "already covered". Enough for a whole thing type; bounds the prompt. */
const MAX_COVERED_NAMES = 400;

const SYSTEM = [
  'You suggest research leads for a catalog of things that are dangerous to pets.',
  'Name specific things of the requested type that veterinary or poison-control sources describe',
  'as harmful to the requested pet, and that are not in the already-covered list (in any spelling,',
  'synonym, brand or scientific name).',
  'One specific thing each, under its common name: a plant species, a named food or ingredient, a',
  'drug, a kind of product, an activity. No categories ("houseplants"), no symptoms or diseases,',
  'no brands unless the brand itself is the hazard.',
  'These are leads only. Each is checked against web sources before anything is published, so',
  'prefer well-documented hazards over obscure guesses, and return fewer rather than pad the list.',
].join('\n');

/** Every thing type paired with every pet type, in a stable order so the cursor means something. */
export function ideationFocuses(taxonomy: Taxonomy): IdeationFocus[] {
  const real = (ids: string[]) => ids.filter((id) => id !== 'unknown').sort();
  return real(taxonomy.thingTypeIds).flatMap((thingTypeId) =>
    real(taxonomy.petTypeIds).map((petTypeId) => ({ thingTypeId, petTypeId })),
  );
}

const CURSOR_KEY = { PK: 'SCRAPERIDEA#CURSOR', SK: 'META' };

/**
 * The next focus after the one the last run used. The position is stored (not derived from
 * the clock) so every focus gets a turn whatever the schedule is.
 */
export async function nextIdeationFocus(
  db: DynamoDBDocumentClient,
  focuses: IdeationFocus[],
): Promise<IdeationFocus | undefined> {
  if (focuses.length === 0) return undefined;
  const result = await db.send(new GetCommand({ TableName: CONTENT_TABLE_NAME, Key: CURSOR_KEY }));
  const last = typeof result.Item?.index === 'number' ? result.Item.index : -1;
  const index = (last + 1) % focuses.length;
  await db.send(
    new PutCommand({
      TableName: CONTENT_TABLE_NAME,
      Item: { ...CURSOR_KEY, index, updatedAt: new Date().toISOString() },
    }),
  );
  return focuses[index];
}

/**
 * Asks the model for hazards the catalog does not cover yet, for when discovery finds nothing
 * new. The model only proposes names: each one is then researched and classified from web
 * sources like any other topic, and still needs a moderator. Fails closed: an error proposes
 * nothing.
 */
export async function ideateTopics(
  client: BedrockRuntimeClient,
  modelId: string,
  opts: {
    focus: IdeationFocus;
    /** Display names for the focus, when the taxonomy has them. */
    thingTypeName?: string;
    petTypeName?: string;
    /** Catalog entries and earlier research in this focus. */
    covered: string[];
    count: number;
  },
): Promise<string[]> {
  if (opts.count <= 0) return [];
  const thingType = opts.thingTypeName ?? opts.focus.thingTypeId;
  const petType = opts.petTypeName ?? opts.focus.petTypeId;
  const covered = [...new Set(opts.covered.map((name) => name.trim()).filter(Boolean))].slice(
    0,
    MAX_COVERED_NAMES,
  );
  const prompt = [
    `Thing type: ${thingType}`,
    `Pet: ${petType}`,
    `Suggest up to ${opts.count}.`,
    '',
    'Already covered:',
    covered.length > 0 ? covered.map((name) => `- ${name}`).join('\n') : '(nothing yet)',
  ].join('\n');

  try {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM }],
        // Not 0: the covered list already steers it, and some variety between runs is the point.
        inferenceConfig: { temperature: 0.7, maxTokens: 512 },
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'suggest_hazards',
                description: 'Specific hazards not in the already-covered list.',
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
          toolChoice: { tool: { name: 'suggest_hazards' } },
        },
      }),
    );
    const input = response.output?.message?.content?.find((b) => b.toolUse)?.toolUse?.input as
      | { names?: unknown[] }
      | undefined;
    const coveredKeys = new Set(covered.map((name) => name.toLowerCase()));
    const names = new Map<string, string>();
    for (const raw of input?.names ?? []) {
      const name = String(raw).trim();
      const key = name.toLowerCase();
      if (name.length < 2 || name.length > 80 || coveredKeys.has(key)) continue;
      if (!names.has(key)) names.set(key, name);
    }
    return [...names.values()].slice(0, opts.count);
  } catch (err) {
    console.warn(`Topic ideation failed for ${thingType}/${petType}: ${String(err)}`);
    return [];
  }
}
