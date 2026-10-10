/** Max-age is short so edits show up quickly; stale-* keeps the site up if the origin errors. */
export const PUBLIC_CACHE_CONTROL =
  'public, max-age=60, stale-while-revalidate=300, stale-if-error=86400';

/** The unauthenticated, user-independent GET endpoints; keep in sync with PUBLIC_API_PATHS in infra/cdk web-stack.ts. */
export const PUBLIC_API_PATHS = ['things', 'thing-types', 'pet-types', 'breeds'] as const;

export function isPublicCacheable(method: string, url: string, statusCode: number): boolean {
  if (method !== 'GET' || statusCode !== 200) return false;
  const path = url.split('?')[0]!;
  return PUBLIC_API_PATHS.some(
    (name) => path === `/api/${name}` || path.startsWith(`/api/${name}/`),
  );
}
