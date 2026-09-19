export interface MemoryStore {
  alreadyCollected(topic: string): Promise<boolean>;
  remember(topic: string, summary: string): Promise<void>;
}

export const SCRAPER_MEMORY_ACTOR_ID = 'btfp-scraper';
export const SCRAPER_MEMORY_NAMESPACE = `/scraper/${SCRAPER_MEMORY_ACTOR_ID}`;
