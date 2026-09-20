const PLACEHOLDER = /^(REPLACE_|change-me)/i;

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Returns `value`, or `localDefault` outside production. In production a
 * missing or placeholder value throws: a silent fallback there means running
 * with a publicly known secret.
 */
export function requireInProduction(
  name: string,
  value: string | undefined,
  localDefault: string,
): string {
  if (!isProduction()) return value ?? localDefault;
  if (!value || PLACEHOLDER.test(value)) {
    throw new Error(`${name} is missing or still a placeholder; refusing to start in production`);
  }
  return value;
}

/** CORS origin. Reflecting any origin is only allowed locally — credentials are enabled. */
export function corsOrigin(): string | true {
  const configured = process.env.WEB_ORIGIN;
  if (configured) return configured;
  if (isProduction()) {
    throw new Error('WEB_ORIGIN must be set in production; refusing to reflect any origin');
  }
  return true;
}
