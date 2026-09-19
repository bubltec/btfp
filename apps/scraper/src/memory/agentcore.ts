import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { SCRAPER_MEMORY_ACTOR_ID, SCRAPER_MEMORY_NAMESPACE, type MemoryStore } from './types.js';

export interface AgentCoreMemoryOptions {
  memoryId: string;
  client?: BedrockAgentCoreClient;
  now?: () => Date;
}

/**
 * Long-term semantic memory of topics this scraper has already researched,
 * so a term that keeps trending across 6h runs is not re-searched/re-billed.
 * Exact-term DynamoDB markers in `seen.ts` cover same-run / immediate skips;
 * this is the cross-run "looks like something we already have" layer.
 */
export class AgentCoreMemoryStore implements MemoryStore {
  private readonly memoryId: string;
  private readonly client: BedrockAgentCoreClient;
  private readonly now: () => Date;

  constructor(options: AgentCoreMemoryOptions) {
    this.memoryId = options.memoryId;
    this.client = options.client ?? new BedrockAgentCoreClient({});
    this.now = options.now ?? (() => new Date());
  }

  async alreadyCollected(topic: string): Promise<boolean> {
    try {
      const result = await this.client.send(
        new RetrieveMemoryRecordsCommand({
          memoryId: this.memoryId,
          namespace: SCRAPER_MEMORY_NAMESPACE,
          maxResults: 5,
          searchCriteria: { searchQuery: topic, topK: 5 },
        }),
      );
      return (result.memoryRecordSummaries ?? []).some((record) =>
        recordLooksLikeTopic(record.content?.text, topic),
      );
    } catch (err) {
      console.log(`AgentCore Memory retrieve failed for "${topic}":`, err);
      return false;
    }
  }

  async remember(topic: string, summary: string): Promise<void> {
    const now = this.now();
    try {
      await this.client.send(
        new CreateEventCommand({
          memoryId: this.memoryId,
          actorId: SCRAPER_MEMORY_ACTOR_ID,
          sessionId: `run-${now.toISOString().slice(0, 13)}`,
          eventTimestamp: now,
          payload: [
            {
              conversational: {
                role: 'USER',
                content: {
                  text: `Collected pet-hazard research for trending topic "${topic}". ${summary}`.slice(
                    0,
                    4000,
                  ),
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      console.log(`AgentCore Memory remember failed for "${topic}":`, err);
    }
  }
}

export function recordLooksLikeTopic(text: string | undefined, topic: string): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  const needle = topic.trim().toLowerCase();
  if (needle.length < 3) return haystack.includes(needle);
  return haystack.includes(needle);
}

export class NoopMemoryStore implements MemoryStore {
  async alreadyCollected(): Promise<boolean> {
    return false;
  }
  async remember(): Promise<void> {}
}
