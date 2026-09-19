import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ScraperConfig } from './config.js';
import { classifyDocument } from './extract/classify.js';
import { loadTaxonomy, loadThingCatalog } from './taxonomy.js';
import { isTopicProcessed, markTopicProcessed } from './seen.js';
import { writeContribution } from './contribution.js';
import { GatewaySearchClient } from './search/gateway.js';
import { documentFromHits, type SearchClient } from './search/types.js';
import { AgentCoreMemoryStore, NoopMemoryStore } from './memory/agentcore.js';
import type { MemoryStore } from './memory/types.js';
import { GoogleTrendsBrowserSource } from './trends/browser.js';
import type { TrendSource } from './trends/types.js';

export interface ScraperDeps {
  trends: TrendSource;
  search: SearchClient;
  memory: MemoryStore;
  classify: typeof classifyDocument;
}

export function buildDeps(config: ScraperConfig): ScraperDeps {
  return {
    trends: new GoogleTrendsBrowserSource({
      region: config.region,
      geo: config.trendsGeo,
      hours: config.trendsHours,
      category: config.trendsCategory,
    }),
    search: new GatewaySearchClient({
      gatewayUrl: config.agentCoreGatewayUrl,
      region: config.region,
    }),
    memory: config.agentCoreMemoryId
      ? new AgentCoreMemoryStore({ memoryId: config.agentCoreMemoryId })
      : new NoopMemoryStore(),
    classify: classifyDocument,
  };
}

function searchQueryFor(topic: string): string {
  return `${topic} toxic for dogs cats pets`.slice(0, 200);
}

export async function run(
  config: ScraperConfig,
  db: DynamoDBDocumentClient,
  deps: ScraperDeps = buildDeps(config),
): Promise<void> {
  if (!config.agentCoreGatewayUrl) {
    console.log('AGENTCORE_GATEWAY_URL not configured, skipping run.');
    return;
  }

  const topics = (await deps.trends.listTrendingTopics()).slice(0, config.maxTopicsPerRun);
  console.log(`Trends: ${topics.length} topics (capped at ${config.maxTopicsPerRun}).`);

  const pending: typeof topics = [];
  let skipped = 0;
  for (const topic of topics) {
    if (
      (await isTopicProcessed(db, topic.term)) ||
      (await deps.memory.alreadyCollected(topic.term))
    ) {
      skipped += 1;
      continue;
    }
    pending.push(topic);
  }

  if (pending.length === 0) {
    console.log(`Run complete: ${topics.length} topics, ${skipped} skipped, 0 candidates written.`);
    return;
  }

  const bedrock = new BedrockRuntimeClient({ region: config.region });
  const taxonomy = await loadTaxonomy(db);
  const catalog = await loadThingCatalog(db);

  let candidateCount = 0;
  for (const topic of pending) {
    const hits = await deps.search.search(searchQueryFor(topic.term), config.maxSearchResults);
    const document = documentFromHits(topic.term, hits);
    if (!document) {
      await markTopicProcessed(db, topic.term);
      await deps.memory.remember(topic.term, 'No web-search hits.');
      continue;
    }

    const extraction = await deps.classify(
      bedrock,
      config.bedrockInferenceProfileId,
      document,
      taxonomy,
    );
    if (extraction?.isPetHazardReport) {
      await writeContribution(db, document, extraction, catalog);
      candidateCount += 1;
    }

    await markTopicProcessed(db, topic.term);
    await deps.memory.remember(
      topic.term,
      extraction?.isPetHazardReport
        ? `Hazard candidate: ${extraction.thingName ?? topic.term}. ${extraction.summary ?? ''}`
        : 'Not classified as a pet-hazard report.',
    );
  }

  console.log(
    `Run complete: ${topics.length} topics, ${skipped} skipped, ${candidateCount} candidates written.`,
  );
}
