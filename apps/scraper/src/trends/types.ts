/**
 * Topic discovery is a pluggable source so a future official Google Trends
 * API client can replace the AgentCore Browser implementation without
 * changing the rest of the pipeline.
 */
export interface TrendTopic {
  term: string;
  relatedTerms?: string[];
}

export interface TrendSource {
  listTrendingTopics(): Promise<TrendTopic[]>;
}

/** Google Trends "Pets and Animals" category on the Trending Now page. */
export const PETS_AND_ANIMALS_CATEGORY = 13;

export const DEFAULT_TRENDS_GEO = 'US';
export const DEFAULT_TRENDS_HOURS = 24;
export const DEFAULT_TRENDS_CATEGORY = PETS_AND_ANIMALS_CATEGORY;

export function trendingNowUrl(geo: string, hours: number, category: number): string {
  const url = new URL('https://trends.google.com/trending');
  url.searchParams.set('geo', geo);
  url.searchParams.set('hours', String(hours));
  url.searchParams.set('category', String(category));
  return url.toString();
}
