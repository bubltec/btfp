export interface SearchHit {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
}

export interface SearchClient {
  search(query: string, maxResults: number): Promise<SearchHit[]>;
}

export interface CandidateDocument {
  id: string;
  title: string;
  body: string;
  sourceUrl: string;
  source: string;
  topic: string;
}

export function documentFromHits(topic: string, hits: SearchHit[]): CandidateDocument | null {
  if (hits.length === 0) return null;
  const primary = hits[0]!;
  const body = hits
    .map((hit, index) => {
      const date = hit.publishedDate ? ` (${hit.publishedDate})` : '';
      return `[${index + 1}] ${hit.title}${date}\n${hit.url}\n${hit.text}`;
    })
    .join('\n\n');

  return {
    id: normalizeTopicId(topic),
    title: topic,
    body,
    sourceUrl: primary.url,
    source: 'web-search',
    topic,
  };
}

export function normalizeTopicId(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
