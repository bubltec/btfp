import { describe, expect, it } from 'vitest';
import { isPublicCacheable, PUBLIC_CACHE_CONTROL } from './public-cache.js';

describe('isPublicCacheable', () => {
  it('marks successful GETs of the public read endpoints', () => {
    for (const url of [
      '/api/things',
      '/api/things?q=lily&petType=cat',
      '/api/things/abc',
      '/api/thing-types',
      '/api/pet-types/dog',
      '/api/breeds?petType=dog',
    ]) {
      expect(isPublicCacheable('GET', url, 200), url).toBe(true);
    }
  });

  it('never marks errors, other methods, or anything outside the list', () => {
    expect(isPublicCacheable('GET', '/api/things/missing', 404)).toBe(false);
    expect(isPublicCacheable('GET', '/api/things', 500)).toBe(false);
    expect(isPublicCacheable('POST', '/api/things', 200)).toBe(false);
    for (const url of [
      '/api/mcp',
      '/api/contributions/pending',
      '/api/verification/quiz',
      '/api/thingsfoo',
      '/api/openapi.json',
      '/sitemap.xml',
    ]) {
      expect(isPublicCacheable('GET', url, 200), url).toBe(false);
    }
  });

  it('allows serving stale on origin errors', () => {
    expect(PUBLIC_CACHE_CONTROL).toMatch(/max-age=60/);
    expect(PUBLIC_CACHE_CONTROL).toMatch(/stale-if-error=\d+/);
  });
});
