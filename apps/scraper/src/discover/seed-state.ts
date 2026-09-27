import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONTENT_TABLE_NAME } from '../dynamo.js';
import { normalizeTrendTerm } from '../trends/parse.js';

/** What a seed query returned before, so a query that keeps returning the same pages backs off. */
export interface SeedState {
  knownUrls: string[];
  /** Consecutive runs that returned no URL not already in knownUrls. */
  staleRuns: number;
  /** ISO time before which the query is not searched again. */
  nextSearchAt?: string;
}

export interface SeedStateStore {
  get(query: string): Promise<SeedState | undefined>;
  put(query: string, state: SeedState): Promise<void>;
}

const BASE_BACKOFF_HOURS = 12;
const MAX_BACKOFF_HOURS = 7 * 24;
const MAX_KNOWN_URLS = 200;

export function isSeedDue(state: SeedState | undefined, now: Date): boolean {
  return !state?.nextSearchAt || Date.parse(state.nextSearchAt) <= now.getTime();
}

/**
 * Folds one search's URLs into the query's state. Any unseen URL resets the backoff; a run
 * with nothing new doubles it (12h, 24h, 48h… capped at a week).
 */
export function nextSeedState(
  prev: SeedState | undefined,
  urls: string[],
  now: Date,
): { state: SeedState; fresh: boolean } {
  const known = new Set(prev?.knownUrls ?? []);
  const fresh = urls.some((url) => !known.has(url));
  const knownUrls = [...new Set([...urls, ...(prev?.knownUrls ?? [])])].slice(0, MAX_KNOWN_URLS);
  if (fresh) return { state: { knownUrls, staleRuns: 0 }, fresh };

  const staleRuns = (prev?.staleRuns ?? 0) + 1;
  const hours = Math.min(BASE_BACKOFF_HOURS * 2 ** (staleRuns - 1), MAX_BACKOFF_HOURS);
  return {
    state: {
      knownUrls,
      staleRuns,
      nextSearchAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    },
    fresh,
  };
}

/** PK: SCRAPERSEED#{normalizedQuery}, SK: META. */
export class DynamoSeedStateStore implements SeedStateStore {
  constructor(private readonly db: DynamoDBDocumentClient) {}

  async get(query: string): Promise<SeedState | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: CONTENT_TABLE_NAME, Key: { PK: seedKey(query), SK: 'META' } }),
    );
    const item = result.Item;
    if (!item) return undefined;
    return {
      knownUrls: Array.isArray(item.knownUrls)
        ? item.knownUrls.filter((url): url is string => typeof url === 'string')
        : [],
      staleRuns: typeof item.staleRuns === 'number' ? item.staleRuns : 0,
      nextSearchAt: typeof item.nextSearchAt === 'string' ? item.nextSearchAt : undefined,
    };
  }

  async put(query: string, state: SeedState): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: CONTENT_TABLE_NAME,
        Item: { PK: seedKey(query), SK: 'META', query, ...state },
      }),
    );
  }
}

export function seedKey(query: string): string {
  return `SCRAPERSEED#${normalizeTrendTerm(query)}`;
}
