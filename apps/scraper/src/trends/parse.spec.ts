import { describe, expect, it } from 'vitest';
import { parseTrendRows, normalizeTrendTerm } from './parse.js';
import { trendingNowUrl, PETS_AND_ANIMALS_CATEGORY } from './types.js';

describe('parseTrendRows', () => {
  it('takes the first line of each row and drops Trends UI chrome', () => {
    const terms = parseTrendRows([
      'Trends',
      'Search volume',
      'xylitol gum\n100K+\n4 hours ago',
      'grape toxicity dogs\n50K+',
      'xylitol gum',
      'Past 24 hours',
    ]);
    expect(terms).toEqual(['xylitol gum', 'grape toxicity dogs']);
  });

  it('drops numeric-only chrome and empty lines', () => {
    expect(parseTrendRows(['', '12', '   ', 'onion powder'])).toEqual(['onion powder']);
  });
});

describe('normalizeTrendTerm', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeTrendTerm('  Xylitol   Gum ')).toBe('xylitol gum');
  });
});

describe('trendingNowUrl', () => {
  it('points at the Pets and Animals Trending Now page', () => {
    expect(trendingNowUrl('US', 24, PETS_AND_ANIMALS_CATEGORY)).toBe(
      'https://trends.google.com/trending?geo=US&hours=24&category=13',
    );
  });
});
