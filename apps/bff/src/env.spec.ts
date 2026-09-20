import { afterEach, describe, expect, it, vi } from 'vitest';
import { corsOrigin, requireInProduction } from './env.js';

afterEach(() => vi.unstubAllEnvs());

describe('requireInProduction', () => {
  it('outside production: uses the value, else the local default', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(requireInProduction('JWT_SECRET', 'real', 'local')).toBe('real');
    expect(requireInProduction('JWT_SECRET', undefined, 'local')).toBe('local');
  });

  it('in production: returns a real value', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(requireInProduction('JWT_SECRET', 'a-real-secret', 'local')).toBe('a-real-secret');
  });

  it.each([undefined, '', 'REPLACE_BEFORE_DEPLOYING_DEV', 'change-me-in-local-env'])(
    'in production: throws for %j instead of falling back',
    (value) => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => requireInProduction('JWT_SECRET', value, 'local')).toThrow(/JWT_SECRET/);
    },
  );
});

describe('corsOrigin', () => {
  it('uses WEB_ORIGIN when set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEB_ORIGIN', 'https://example.com');
    expect(corsOrigin()).toBe('https://example.com');
  });

  it('reflects any origin only outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WEB_ORIGIN', '');
    expect(corsOrigin()).toBe(true);
  });

  it('throws in production when WEB_ORIGIN is unset', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEB_ORIGIN', '');
    expect(() => corsOrigin()).toThrow(/WEB_ORIGIN/);
  });
});
