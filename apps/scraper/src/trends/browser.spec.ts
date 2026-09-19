import { describe, expect, it, vi } from 'vitest';
import { GoogleTrendsBrowserSource } from './browser.js';

describe('GoogleTrendsBrowserSource', () => {
  it('opens the Pets and Animals Trending Now URL and returns parsed terms', async () => {
    const goto = vi.fn();
    const source = new GoogleTrendsBrowserSource({
      region: 'us-east-1',
      geo: 'US',
      hours: 24,
      category: 13,
      withPage: async (_opts, fn) =>
        fn({
          goto,
          waitForFunction: async () => undefined,
          locator: () => ({ allInnerTexts: async () => ['xylitol gum\n100K+', 'Trends'] }),
        } as never),
    });

    await expect(source.listTrendingTopics()).resolves.toEqual([{ term: 'xylitol gum' }]);
    expect(goto).toHaveBeenCalledWith(
      'https://trends.google.com/trending?geo=US&hours=24&category=13',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
  });
});
