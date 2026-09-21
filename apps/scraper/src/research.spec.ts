import { describe, expect, it, vi } from 'vitest';
import { researchQueries, researchTopic } from './research.js';

describe('researchTopic', () => {
  it('asks about dogs, cats and symptoms', () => {
    expect(researchQueries('xylitol')).toEqual([
      'xylitol toxic to dogs',
      'xylitol toxic to cats',
      'xylitol pet poisoning symptoms treatment veterinarian',
    ]);
  });

  it('merges hits across queries, de-duplicating by url and capping the total', async () => {
    const search = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { title: 'a', url: 'u1', text: '1' },
          { title: 'b', url: 'u2', text: '2' },
        ])
        .mockResolvedValueOnce([
          { title: 'b again', url: 'u2', text: '2' },
          { title: 'c', url: 'u3', text: '3' },
        ])
        .mockRejectedValueOnce(new Error('gateway down')),
    };
    const hits = await researchTopic(search, 'xylitol', 5, 3);
    expect(hits.map((h) => h.url)).toEqual(['u1', 'u2', 'u3']);
  });
});
