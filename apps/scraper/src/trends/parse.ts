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
  // Page chrome. This is what the old `<a>` fallback mistook for trending topics.
  'home',
  'explore',
  'trending now',
  'sign in',
  'help',
  'send feedback',
  'privacy',
  'terms',
  'about',
  'export',
  'all trends',
  'by relevance',
  'search trends',
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
    // Rendered rows start with "\t\n", so the first line is blank; take the first real one.
    const firstLine =
      row
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? '';
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
