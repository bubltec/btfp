import {
  DEFAULT_TRENDS_CATEGORY,
  DEFAULT_TRENDS_GEO,
  DEFAULT_TRENDS_HOURS,
} from './trends/types.js';

export interface ScraperConfig {
  env: string;
  region: string;
  bedrockInferenceProfileId: string;
  agentCoreGatewayUrl: string;
  agentCoreMemoryId: string;
  trendsGeo: string;
  trendsHours: number;
  trendsCategory: number;
  maxTopicsPerRun: number;
  maxSearchResults: number;
}

const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * All config is env vars baked into the Fargate task definition. No Reddit
 * (or other third-party) secrets — AgentCore Browser / Gateway / Memory
 * authenticate via the task role.
 */
export function loadConfig(): ScraperConfig {
  return {
    env: process.env.STAGE ?? 'dev',
    region: process.env.AWS_REGION ?? 'us-east-1',
    bedrockInferenceProfileId: process.env.BEDROCK_INFERENCE_PROFILE_ID ?? DEFAULT_MODEL_ID,
    agentCoreGatewayUrl: process.env.AGENTCORE_GATEWAY_URL ?? '',
    agentCoreMemoryId: process.env.AGENTCORE_MEMORY_ID ?? '',
    trendsGeo: process.env.TRENDS_GEO ?? DEFAULT_TRENDS_GEO,
    trendsHours: Number(process.env.TRENDS_HOURS ?? DEFAULT_TRENDS_HOURS),
    trendsCategory: Number(process.env.TRENDS_CATEGORY ?? DEFAULT_TRENDS_CATEGORY),
    maxTopicsPerRun: Number(process.env.MAX_TOPICS_PER_RUN ?? 8),
    maxSearchResults: Number(process.env.MAX_SEARCH_RESULTS ?? 5),
  };
}
