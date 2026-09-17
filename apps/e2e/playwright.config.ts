import { defineConfig } from '@playwright/test';

// Point at local dev by default; override for the deployed dev/prod stages,
// e.g. BASE_URL=https://d11hklju47pzyo.cloudfront.net (dev is Basic
// Auth-locked — see docs/infra.md — so pass BASIC_AUTH_USER/PASSWORD too).
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';

const basicAuthUser = process.env.BASIC_AUTH_USER;
const basicAuthPassword = process.env.BASIC_AUTH_PASSWORD;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...(basicAuthUser && basicAuthPassword
      ? { httpCredentials: { username: basicAuthUser, password: basicAuthPassword } }
      : {}),
  },
});
