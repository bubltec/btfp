import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ScraperConfig } from './config.js';
import { classifyDocument } from './extract/classify.js';
import { triageTopics } from './extract/triage.js';
import { discoverFromSearch } from './discover/seed-search.js';
import { researchTopic } from './research.js';
import { loadTaxonomy, loadThingCatalog } from './taxonomy.js';
import { isTopicProcessed, markTopicProcessed } from './seen.js';
import { isFileableExtraction, writeContribution } from './contribution.js';
import { GatewaySearchClient } from './search/gateway.js';
import { documentFromHits, type SearchClient } from './search/types.js';
import { AgentCoreMemoryStore, NoopMemoryStore } from './memory/agentcore.js';
import type { MemoryStore } from './memory/types.js';
import { GoogleTrendsBrowserSource } from './trends/browser.js';
import type { TrendSource, TrendTopic } from './trends/types.js';

export interface ScraperDeps {
  trends: TrendSource;
  search: SearchClient;
  memory: MemoryStore;
  classify: typeof classifyDocument;
  triage: typeof triageTopics;
  discover: typeof discoverFromSearch;
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
    triage: triageTopics,
    discover: discoverFromSearch,
  };
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

  const bedrock = new BedrockRuntimeClient({ region: config.region });
  const model = config.bedrockInferenceProfileId;

  // Trending Now is mostly sports and news, so it only contributes topics a triage pass says
  // could be a hazard. A Trends outage must not stop the search-driven discovery below.
  let trending: TrendTopic[] = [];
  try {
    trending = await deps.trends.listTrendingTopics();
  } catch (err) {
    console.warn(`Trends unavailable, continuing with search discovery: ${String(err)}`);
  }
  const relevant = await deps.triage(
    bedrock,
    model,
    trending.map((t) => t.term),
  );
  const discovered = await deps.discover(deps.search, bedrock, model, {
    maxResults: config.maxSearchResults,
  });
  const unique = new Map<string, TrendTopic>();
  for (const topic of [...relevant.map((term) => ({ term })), ...discovered]) {
    const key = topic.term.trim().toLowerCase();
    if (!unique.has(key)) unique.set(key, topic);
  }
  const topics = [...unique.values()];
  console.log(
    `Topics: ${trending.length} trending → ${relevant.length} relevant, ${discovered.length} from search; ${topics.length} unique; researching up to ${config.maxTopicsPerRun} new ones.`,
  );

  const pending: typeof topics = [];
  let skipped = 0;
  for (const topic of topics) {
    // Cap after filtering out seen topics. Capping first meant the same first N discovered
    // topics were skipped every run and nothing new was ever researched.
    if (pending.length >= config.maxTopicsPerRun) break;
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

  const taxonomy = await loadTaxonomy(db);
  const catalog = await loadThingCatalog(db);

  let candidateCount = 0;
  for (const topic of pending) {
    const hits = await researchTopic(deps.search, topic.term, config.maxSearchResults);
    const document = documentFromHits(topic.term, hits);
    if (!document) {
      await markTopicProcessed(db, topic.term);
      await deps.memory.remember(topic.term, 'No web-search hits.');
      continue;
    }

    const extraction = await deps.classify(bedrock, model, document, taxonomy);
    const fileable = Boolean(extraction?.isPetHazardReport && isFileableExtraction(extraction));
    if (fileable && extraction) {
      await writeContribution(db, document, extraction, catalog);
      candidateCount += 1;
    }

    await markTopicProcessed(db, topic.term);
    await deps.memory.remember(
      topic.term,
      fileable && extraction
        ? `Hazard candidate: ${extraction.thingName}. ${extraction.summary ?? ''}`
        : extraction?.isPetHazardReport
          ? 'Pet-hazard report without a usable name and type; not filed.'
          : 'Not classified as a pet-hazard report.',
    );
  }

  console.log(
    `Run complete: ${topics.length} topics, ${skipped} skipped, ${candidateCount} candidates written.`,
  );
}
