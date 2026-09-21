import type { SearchClient, SearchHit } from './search/types.js';

/** Angles that make a single web search into a research pass over one candidate. */
export function researchQueries(topic: string): string[] {
  return [
    `${topic} toxic to dogs`,
    `${topic} toxic to cats`,
    `${topic} pet poisoning symptoms treatment veterinarian`,
  ].map((q) => q.slice(0, 200));
}

/**
 * Several searches per topic, de-duplicated by URL, so the classifier sees independent
 * sources instead of one query's top hits. A failed search is skipped, not fatal.
 */
export async function researchTopic(
  search: SearchClient,
  topic: string,
  maxResultsPerQuery: number,
  maxHits = 10,
): Promise<SearchHit[]> {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const query of researchQueries(topic)) {
    let results: SearchHit[];
    try {
      results = await search.search(query, maxResultsPerQuery);
    } catch (err) {
      console.warn(`Search failed for "${query}": ${String(err)}`);
      continue;
    }
    for (const hit of results) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
      if (hits.length >= maxHits) return hits;
    }
  }
  return hits;
}
