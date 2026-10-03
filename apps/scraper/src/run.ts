import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { normalizedPrimaryName } from '@btfp/shared-types';
import type { ScraperConfig } from './config.js';
import { classifyDocument } from './extract/classify.js';
import { triageTopics } from './extract/triage.js';
import { ideateTopics, ideationFocuses, nextIdeationFocus } from './discover/ideate.js';
import { discoverFromSearch } from './discover/seed-search.js';
import { DynamoSeedStateStore } from './discover/seed-state.js';
import {
  fillsGap,
  markEnriched,
  rankEnrichmentTargets,
  wasRecentlyEnriched,
  type EnrichmentTarget,
} from './enrich.js';
import { researchTopic } from './research.js';
import { loadTaxonomy, loadThingCatalog, type CatalogThing } from './taxonomy.js';
import { isTopicProcessed, markTopicProcessed } from './seen.js';
import { isFileableExtraction, writeContribution } from './contribution.js';
import { GatewaySearchClient } from './search/gateway.js';
import { documentFromHits, type SearchClient } from './search/types.js';
import { AgentCoreMemoryStore, NoopMemoryStore } from './memory/agentcore.js';
import type { MemoryStore, ResearchRecord } from './memory/types.js';
import { assessNovelty, judgeDuplicates } from './novelty.js';
import { GoogleTrendsBrowserSource } from './trends/browser.js';
import type { TrendSource, TrendTopic } from './trends/types.js';
import type { ExtractionResult, Taxonomy } from './extract/types.js';

export interface ScraperDeps {
  trends: TrendSource;
  search: SearchClient;
  memory: MemoryStore;
  classify: typeof classifyDocument;
  triage: typeof triageTopics;
  discover: typeof discoverFromSearch;
  judge: typeof judgeDuplicates;
  ideate: typeof ideateTopics;
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
    judge: judgeDuplicates,
    ideate: ideateTopics,
  };
}

/** Earlier research recalled to tell the model what a focus already covers. */
const IDEATION_RECALL_LIMIT = 20;
/** Suggestions asked for per open slot; some will turn out to be known under another name. */
const IDEAS_PER_SLOT = 3;

interface SkipCounts {
  seen: number;
  inCatalog: number;
  duplicate: number;
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
  // The trend list barely changes between runs. Only terms never judged before go to the
  // model, and the ones it rules out are remembered, so an unchanged list costs no call.
  const unjudged: string[] = [];
  for (const topic of trending) {
    if (!(await isTopicProcessed(db, topic.term))) unjudged.push(topic.term);
  }
  const triaged = await deps.triage(bedrock, model, unjudged);
  for (const term of triaged.rejected) await markTopicProcessed(db, term, 'triaged_out');

  const discovered = await deps.discover(deps.search, bedrock, model, {
    maxResults: config.maxSearchResults,
    seedState: new DynamoSeedStateStore(db),
  });
  const topics = uniqueTerms([...triaged.relevant, ...discovered.map((topic) => topic.term)]);
  console.log(
    `Topics: ${trending.length} trending (${unjudged.length} not judged before) → ` +
      `${triaged.relevant.length} relevant, ${discovered.length} from search; ` +
      `${topics.length} unique; researching up to ${config.maxTopicsPerRun} new ones.`,
  );

  const taxonomy = await loadTaxonomy(db);
  const catalog = await loadThingCatalog(db);
  const catalogNames = new Set(
    catalog
      .flatMap((thing) => [thing.name, ...(thing.otherNames ?? [])])
      .map(normalizedPrimaryName),
  );
  const skipped: SkipCounts = { seen: 0, inCatalog: 0, duplicate: 0 };

  /**
   * Takes terms in order until `limit` of them are new. A term is closed without research
   * when it was processed before, is already a catalog entry, or memory shows it is another
   * name for something researched earlier. Each closes with a marker, so the next run drops
   * it on the first, cheapest check.
   */
  const admit = async (terms: string[], limit: number): Promise<string[]> => {
    const queue = [...terms];
    const admitted: string[] = [];
    // Capped after filtering. Capping first meant the same first N discovered topics were
    // skipped every run and nothing new was ever researched.
    while (admitted.length < limit && queue.length > 0) {
      const batch: string[] = [];
      while (batch.length < limit - admitted.length && queue.length > 0) {
        const term = queue.shift()!;
        if (await isTopicProcessed(db, term)) {
          skipped.seen += 1;
        } else if (catalogNames.has(normalizedPrimaryName(term))) {
          await markTopicProcessed(db, term, 'in_catalog');
          skipped.inCatalog += 1;
        } else {
          batch.push(term);
        }
      }
      for (const verdict of await assessNovelty(deps.memory, deps.judge, bedrock, model, batch)) {
        if (verdict.duplicateOf) {
          console.log(`Skipping "${verdict.term}": same as "${verdict.duplicateOf}".`);
          await markTopicProcessed(db, verdict.term, 'duplicate', verdict.duplicateOf);
          skipped.duplicate += 1;
        } else {
          admitted.push(verdict.term);
        }
      }
    }
    return admitted;
  };

  const pending = await admit(topics, config.maxTopicsPerRun);

  // Discovery mostly returns what is already known. When it leaves room, ask the model what
  // the catalog is missing, one corner of it per run, instead of researching nothing new.
  const ideaBudget = Math.min(config.maxIdeasPerRun, config.maxTopicsPerRun - pending.length);
  let ideated: string[] = [];
  if (ideaBudget > 0) {
    ideated = await ideate(db, deps, bedrock, model, taxonomy, catalog, ideaBudget, admit);
    pending.push(...ideated);
  }

  let candidateCount = 0;
  for (const term of pending) {
    const hits = await researchTopic(deps.search, term, config.maxSearchResults);
    const document = documentFromHits(term, hits);
    const extraction = document ? await deps.classify(bedrock, model, document, taxonomy) : null;
    const record = researchRecord(term, Boolean(document), extraction);
    if (document && extraction && record.outcome === 'filed') {
      await writeContribution(db, document, extraction, catalog);
      candidateCount += 1;
    }
    await markTopicProcessed(db, term, record.outcome === 'unknown' ? undefined : record.outcome);
    await deps.memory.remember(record);
  }

  // Whatever budget new topics didn't use goes to existing entries that still say "unknown"
  // for some pets.
  const enrichBudget = config.maxTopicsPerRun - pending.length;
  const enriched =
    enrichBudget > 0
      ? await enrichCatalog(db, deps, bedrock, model, config, taxonomy, catalog, enrichBudget)
      : { attempted: 0, filed: 0 };

  console.log(
    `Run complete: ${pending.length} topics researched (${ideated.length} suggested by the model), ` +
      `${candidateCount} candidates written; skipped ${skipped.seen} seen before, ` +
      `${skipped.inCatalog} already in the catalog, ${skipped.duplicate} duplicates; ` +
      `${enriched.attempted} existing entries researched, ${enriched.filed} updates filed.`,
  );
}

function uniqueTerms(terms: string[]): string[] {
  const unique = new Map<string, string>();
  for (const term of terms) {
    const key = term.trim().toLowerCase();
    if (!unique.has(key)) unique.set(key, term);
  }
  return [...unique.values()];
}

/** What memory keeps about one researched topic. */
export function researchRecord(
  term: string,
  hadHits: boolean,
  extraction: ExtractionResult | null,
): ResearchRecord {
  if (!hadHits) return { term, outcome: 'no_hits', summary: 'No web-search hits.' };
  if (!extraction?.isPetHazardReport) {
    return { term, outcome: 'not_hazard', summary: 'Not classified as a pet-hazard report.' };
  }
  const name = extraction.thingName?.trim() || undefined;
  if (!isFileableExtraction(extraction)) {
    return {
      term,
      name,
      outcome: 'unusable',
      summary: 'Pet-hazard report without a usable name, type or confidence; not filed.',
    };
  }
  return { term, name, outcome: 'filed', summary: extraction.summary ?? 'Hazard candidate filed.' };
}

async function ideate(
  db: DynamoDBDocumentClient,
  deps: ScraperDeps,
  bedrock: BedrockRuntimeClient,
  model: string,
  taxonomy: Taxonomy,
  catalog: CatalogThing[],
  budget: number,
  admit: (terms: string[], limit: number) => Promise<string[]>,
): Promise<string[]> {
  const focus = await nextIdeationFocus(db, ideationFocuses(taxonomy));
  if (!focus) return [];
  const thingTypeName = taxonomy.thingTypeNames?.[focus.thingTypeId] ?? focus.thingTypeId;
  const petTypeName = taxonomy.petTypeNames?.[focus.petTypeId] ?? focus.petTypeId;

  // The catalog says what is published; memory adds what was researched and turned down,
  // which the catalog cannot show and the model would otherwise suggest again.
  const recalled = await deps.memory.recall(
    `${thingTypeName} harmful to ${petTypeName}`,
    IDEATION_RECALL_LIMIT,
  );
  const covered = [
    ...catalog
      .filter((thing) => thing.thingTypeId === focus.thingTypeId)
      .map((thing) => thing.name),
    ...recalled.flatMap((record) => [record.term, ...(record.name ? [record.name] : [])]),
  ];
  const ideas = await deps.ideate(bedrock, model, {
    focus,
    thingTypeName,
    petTypeName,
    covered,
    count: budget * IDEAS_PER_SLOT,
  });
  const admitted = await admit(ideas, budget);
  console.log(
    `Ideation (${thingTypeName} / ${petTypeName}): ${ideas.length} suggested, ${admitted.length} new.`,
  );
  return admitted;
}

async function enrichCatalog(
  db: DynamoDBDocumentClient,
  deps: ScraperDeps,
  bedrock: BedrockRuntimeClient,
  model: string,
  config: ScraperConfig,
  taxonomy: Taxonomy,
  catalog: CatalogThing[],
  budget: number,
): Promise<{ attempted: number; filed: number }> {
  const now = new Date();
  const targets: EnrichmentTarget[] = [];
  for (const target of rankEnrichmentTargets(catalog, taxonomy.petTypeIds)) {
    if (targets.length >= budget) break;
    if (await wasRecentlyEnriched(db, target.thing.id, now)) continue;
    targets.push(target);
  }

  let filed = 0;
  for (const target of targets) {
    const { thing, gaps } = target;
    const hits = await researchTopic(
      deps.search,
      thing.name,
      config.maxSearchResults,
      undefined,
      gaps,
    );
    const document = documentFromHits(thing.name, hits);
    if (!document) {
      await markEnriched(db, target, 'No web-search hits.', now);
      continue;
    }

    const extraction = await deps.classify(
      bedrock,
      model,
      { ...document, focusPetTypeIds: gaps },
      taxonomy,
    );
    if (!extraction || !fillsGap(extraction, gaps)) {
      await markEnriched(db, target, 'No new severity found.', now);
      continue;
    }

    // File against this entry by its own name and type, so a classifier rename can't turn
    // an update into a new-thing proposal.
    await writeContribution(
      db,
      document,
      { ...extraction, thingName: thing.name, thingTypeId: thing.thingTypeId },
      [thing],
    );
    filed += 1;
    await markEnriched(db, target, 'Update filed.', now);
  }
  return { attempted: targets.length, filed };
}
