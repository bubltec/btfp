import { createHash } from 'node:crypto';
import {
  BatchCreateMemoryRecordsCommand,
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
  type MemoryRecordSummary,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  SCRAPER_MEMORY_NAMESPACE,
  type MemoryStore,
  type RecalledResearch,
  type ResearchOutcome,
  type ResearchRecord,
} from './types.js';

export interface AgentCoreMemoryOptions {
  memoryId: string;
  client?: BedrockAgentCoreClient;
  now?: () => Date;
}

const OUTCOMES: ResearchOutcome[] = ['filed', 'not_hazard', 'unusable', 'no_hits', 'unknown'];

/**
 * Long-term memory of what the scraper has already researched: one record per topic, written
 * directly with `BatchCreateMemoryRecords`, with the term, hazard name and outcome as metadata.
 *
 * It does not use `CreateEvent`. Events go through the semantic strategy, where a model
 * rewrites them into merged summaries ("…researching toxic foods (chocolate, grapes, xylitol,
 * …)") minutes later. Those cost an extraction call per event, and a topic that is only
 * mentioned inside another topic's summary looks already researched.
 *
 * Exact-term DynamoDB markers in `seen.ts` stop a repeat of the same term. This is the layer
 * for a different term that means the same thing; `novelty.ts` decides what counts.
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

  async recall(query: string, limit: number): Promise<RecalledResearch[]> {
    try {
      const result = await this.client.send(
        new RetrieveMemoryRecordsCommand({
          memoryId: this.memoryId,
          namespace: SCRAPER_MEMORY_NAMESPACE,
          maxResults: limit,
          searchCriteria: { searchQuery: query.slice(0, 500), topK: limit },
        }),
      );
      return (result.memoryRecordSummaries ?? [])
        .map(toRecalled)
        .filter((record): record is RecalledResearch => record !== undefined)
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      // A memory outage must not block the run; the topic is researched as if it were new.
      console.warn(`AgentCore Memory recall failed for "${query}": ${String(err)}`);
      return [];
    }
  }

  async remember(record: ResearchRecord): Promise<void> {
    const name = record.name?.trim();
    try {
      const result = await this.client.send(
        new BatchCreateMemoryRecordsCommand({
          memoryId: this.memoryId,
          records: [
            {
              requestIdentifier: requestId(record.term),
              namespaces: [SCRAPER_MEMORY_NAMESPACE],
              content: { text: recordText(record) },
              timestamp: this.now(),
              metadata: {
                term: { stringValue: record.term.slice(0, 200) },
                ...(name ? { name: { stringValue: name.slice(0, 200) } } : {}),
                outcome: { stringValue: record.outcome },
              },
            },
          ],
        }),
      );
      const failed = result.failedRecords?.[0];
      if (failed) {
        console.warn(
          `AgentCore Memory rejected "${record.term}": ${failed.errorMessage ?? failed.errorCode}`,
        );
      }
    } catch (err) {
      console.warn(`AgentCore Memory remember failed for "${record.term}": ${String(err)}`);
    }
  }
}

/** The text that gets embedded. The term and name lead so a search for either lands on it. */
export function recordText(record: ResearchRecord): string {
  const name = record.name?.trim();
  return [`Researched topic: ${record.term}.`, name ? `Hazard: ${name}.` : '', record.summary]
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);
}

function requestId(term: string): string {
  return `topic-${createHash('sha256').update(term.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
}

/** Records without a `term` are not ours (or predate this format) and are ignored. */
function toRecalled(summary: MemoryRecordSummary): RecalledResearch | undefined {
  const term = summary.metadata?.term?.stringValue;
  if (!term) return undefined;
  const outcome = summary.metadata?.outcome?.stringValue as ResearchOutcome | undefined;
  return {
    term,
    name: summary.metadata?.name?.stringValue,
    outcome: outcome && OUTCOMES.includes(outcome) ? outcome : 'unknown',
    summary: summary.content?.text ?? '',
    score: summary.score ?? 0,
  };
}

export class NoopMemoryStore implements MemoryStore {
  async recall(): Promise<RecalledResearch[]> {
    return [];
  }
  async remember(): Promise<void> {}
}
