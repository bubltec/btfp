/** What came of researching a topic. `unknown` is for records backfilled from Dynamo markers. */
export type ResearchOutcome = 'filed' | 'not_hazard' | 'unusable' | 'no_hits' | 'unknown';

/** One researched topic. Stored as one memory record, so recall never mixes topics. */
export interface ResearchRecord {
  /** The term that was researched, as discovered. */
  term: string;
  /** The hazard the classifier named, when it named one (for example "Xylitol" for "birch sugar"). */
  name?: string;
  outcome: ResearchOutcome;
  summary: string;
}

export interface RecalledResearch extends ResearchRecord {
  /** Relevance to the recall query. Higher is closer; see SIMILARITY_FLOOR in novelty.ts. */
  score: number;
}

export interface MemoryStore {
  /** Previously researched topics most similar to `query`, best first. Empty on any failure. */
  recall(query: string, limit: number): Promise<RecalledResearch[]>;
  remember(record: ResearchRecord): Promise<void>;
}

export const SCRAPER_MEMORY_ACTOR_ID = 'btfp-scraper';

/**
 * Not `/scraper/{actorId}`: that namespace holds the records the semantic strategy used to
 * extract from events, which merge dozens of topics into one summary and cannot be matched
 * against a single topic.
 */
export const SCRAPER_MEMORY_NAMESPACE = `/researched/${SCRAPER_MEMORY_ACTOR_ID}/`;
