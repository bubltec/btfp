/** Unauthenticated, user-independent GET endpoints under /api, cached at CloudFront. Keep in sync with apps/bff/src/app.ts. */
export const PUBLIC_API_PATHS = ['things', 'thing-types', 'pet-types', 'breeds'] as const;
