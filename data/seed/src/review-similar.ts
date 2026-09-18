import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Thing } from '@btfp/shared-types';

export interface ComboSplitMember {
  name: string;
  scientificName?: string;
}

export interface ComboReview {
  /** True when `name` bundles multiple distinct items into one row. */
  isComboEntry: boolean;
  /** Proposed individual entries, only meaningful when isComboEntry is true. */
  members: ComboSplitMember[];
  /** Existing catalog rows this entry overlaps/complements — merge, don't append. */
  overlapsExisting: string[];
  reasoning: string;
}

const MIN_LIST_MEMBERS = 2;

/**
 * Cheap local pre-filter before spending a Bedrock call: names that read like
 * a list ("Onions, garlic, leeks, chives, shallots (Allium spp.)", "Ibuprofen
 * & Naproxen") are the ones worth asking about. This deliberately over-selects
 * — Bedrock (and a human) makes the real call, this just avoids reviewing the
 * whole catalog.
 */
export function looksLikeComboName(name: string): boolean {
  const stripped = name.replace(/\([^)]*\)/g, '').trim();
  const commaParts = stripped.split(',').filter((part) => part.trim().length > 0);
  const hasAnd = /\band\b/i.test(stripped) || stripped.includes('&');
  return commaParts.length >= MIN_LIST_MEMBERS || hasAnd;
}

function buildPrompt(candidate: Thing, existingNames: string[]): string {
  return (
    `A pet-hazard catalog row, possibly bundling more than one distinct hazard into a single entry:\n\n` +
    `Name: ${candidate.name}\n` +
    `Type: ${candidate.thingTypeId}\n` +
    `Other names: ${candidate.otherNames.join(', ') || '(none)'}\n` +
    `Details: ${JSON.stringify(candidate.details)}\n\n` +
    `Other existing "${candidate.thingTypeId}" entries in the catalog (name only, for overlap checking):\n` +
    `${existingNames.slice(0, 200).join(', ') || '(none)'}\n\n` +
    `Decide: does "Name" actually describe multiple distinct items that a pet owner would look up ` +
    `separately (e.g. individual foods, individual species), where lumping them together hides that ` +
    `one member may be more dangerous than another? If so, list each as its own entry. Also flag any ` +
    `existing catalog entries above that describe the same or a related item, so their details (severity, ` +
    `clinical signs, etc.) can be merged into the split entries instead of left as a stale duplicate.`
  );
}

/**
 * Analyzes a single candidate row for Bedrock's opinion on whether it's a
 * combo entry that should be split, and whether it overlaps existing catalog
 * rows that should complement it rather than sit beside it unmerged.
 *
 * A signal for the human curator, not a gate — see docs/data-sourcing.md.
 * Nothing here rewrites seed source files; it only prints a report. Returns
 * null (skip, don't block the run) if Bedrock is unavailable or replies with
 * a malformed tool call.
 */
export async function reviewComboCandidate(
  client: BedrockRuntimeClient,
  modelId: string,
  candidate: Thing,
  existingNames: string[],
): Promise<ComboReview | null> {
  try {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        messages: [{ role: 'user', content: [{ text: buildPrompt(candidate, existingNames) }] }],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'review_combo_entry',
                description:
                  'Decide whether a catalog entry name bundles multiple distinct hazards and should be split, and flag overlapping existing entries.',
                inputSchema: {
                  json: {
                    type: 'object',
                    properties: {
                      isComboEntry: { type: 'boolean' },
                      members: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            scientificName: { type: 'string' },
                          },
                          required: ['name'],
                        },
                      },
                      overlapsExisting: { type: 'array', items: { type: 'string' } },
                      reasoning: { type: 'string' },
                    },
                    required: ['isComboEntry', 'members', 'overlapsExisting', 'reasoning'],
                  },
                },
              },
            },
          ],
          toolChoice: { tool: { name: 'review_combo_entry' } },
        },
      }),
    );

    const toolUse = response.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
    const input = toolUse?.input as ComboReview | undefined;
    if (!input || typeof input.isComboEntry !== 'boolean' || !Array.isArray(input.members)) {
      return null;
    }
    return input;
  } catch {
    return null;
  }
}

/** Runs reviewComboCandidate over every combo-looking name in `things`. */
export async function reviewCatalog(
  client: BedrockRuntimeClient,
  modelId: string,
  things: Thing[],
): Promise<{ thing: Thing; review: ComboReview }[]> {
  const results: { thing: Thing; review: ComboReview }[] = [];
  const byType = new Map<string, string[]>();
  for (const thing of things) {
    byType.set(thing.thingTypeId, [...(byType.get(thing.thingTypeId) ?? []), thing.name]);
  }

  for (const candidate of things) {
    if (!looksLikeComboName(candidate.name)) continue;
    const existingNames = (byType.get(candidate.thingTypeId) ?? []).filter(
      (name) => name !== candidate.name,
    );
    const review = await reviewComboCandidate(client, modelId, candidate, existingNames);
    if (review?.isComboEntry) results.push({ thing: candidate, review });
  }
  return results;
}
