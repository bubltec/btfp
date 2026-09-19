const HEADER_TOKENS = new Set([
  'trends',
  'search volume',
  'started',
  'trend breakdown',
  'trend status',
  'active',
  'lasted',
  'past 4 hours',
  'past 24 hours',
  'past 48 hours',
  'past 7 days',
  'pets and animals',
  'sort by title',
  'sort by search volume',
  'all categories',
]);

export function normalizeTrendTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Turns rendered Trending Now row text (first line = query) into a unique
 * list of search terms. Headers and chrome from the Trends UI are dropped.
 */
export function parseTrendRows(rowTexts: string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const row of rowTexts) {
    const firstLine = row.split('\n')[0]?.trim() ?? '';
    if (!firstLine) continue;
    if (HEADER_TOKENS.has(firstLine.toLowerCase())) continue;
    if (firstLine.length < 2 || firstLine.length > 80) continue;
    if (/^\d/.test(firstLine) && firstLine.length < 6) continue;

    const key = normalizeTrendTerm(firstLine);
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(firstLine);
  }

  return terms;
}
