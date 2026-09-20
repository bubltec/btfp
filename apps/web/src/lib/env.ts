/** Runtime host check — not SITE_ORIGIN, which is hardcoded to prod for prerender. */
export function isNonProdHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('dev.');
}
