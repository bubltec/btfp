import type { MycotaAuthConfig } from '@bubltec/mycota-auth';
import { USERS_TABLE_NAME } from './dynamo/dynamo.constants.js';
import { requireInProduction } from './env.js';

/**
 * The one place in apps/bff that still reads these process.env names —
 * unchanged from before the mycota extraction, so existing
 * .env/.env.deploy.local/SSM values keep working with zero redeploy
 * surprises. Called lazily by MycotaAuthModule.forRootAsync's useFactory
 * (see app.module.ts) — see auth.module.ts for why that matters for
 * GITHUB_CLIENT_SECRET specifically.
 */
export function buildMycotaAuthConfig(): MycotaAuthConfig {
  return {
    jwtSecret: requireInProduction('JWT_SECRET', process.env.JWT_SECRET, 'change-me-in-local-env'),
    webOrigin: requireInProduction('WEB_ORIGIN', process.env.WEB_ORIGIN, 'http://localhost:5173'),
    usersTableName: USERS_TABLE_NAME,
    emailFromAddress: process.env.SES_FROM_ADDRESS ?? 'noreply@badthingsforpets.com',
    sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'btfp_session',
    stage: process.env.STAGE,
    awsRegion: process.env.AWS_REGION,
    bedrockInferenceProfileId: process.env.BEDROCK_INFERENCE_PROFILE_ID,
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
      callbackUrl:
        process.env.GITHUB_CALLBACK_URL ?? 'http://localhost:3001/api/auth/github/callback',
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      callbackUrl:
        process.env.GOOGLE_CALLBACK_URL ?? 'http://localhost:3001/api/auth/google/callback',
    },
  };
}
