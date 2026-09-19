import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { chromium, type Page } from 'playwright-core';

const DEFAULT_BROWSER_ID = 'aws.browser.v1';

export interface BrowserSessionOptions {
  region: string;
  browserIdentifier?: string;
  client?: BedrockAgentCoreClient;
}

/**
 * Starts a managed AgentCore Browser session and hands Playwright a signed
 * CDP WebSocket. The Fargate task never installs Chrome — it only drives the
 * remote browser.
 */
export async function withAgentCorePage<T>(
  options: BrowserSessionOptions,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const region = options.region;
  const browserIdentifier = options.browserIdentifier ?? DEFAULT_BROWSER_ID;
  const client = options.client ?? new BedrockAgentCoreClient({ region });

  const started = await client.send(
    new StartBrowserSessionCommand({
      browserIdentifier,
      name: 'btfp-trends',
      sessionTimeoutSeconds: 300,
    }),
  );
  const sessionId = started.sessionId;
  if (!sessionId) throw new Error('StartBrowserSession returned no sessionId');

  try {
    const { url, headers } = await signAutomationSocket(region, browserIdentifier, sessionId);
    const browser = await chromium.connectOverCDP(url, { headers });
    try {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      return await fn(page);
    } finally {
      await browser.close().catch(() => undefined);
    }
  } finally {
    await client
      .send(new StopBrowserSessionCommand({ browserIdentifier, sessionId }))
      .catch(() => undefined);
  }
}

export async function signAutomationSocket(
  region: string,
  browserIdentifier: string,
  sessionId: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const host = `bedrock-agentcore.${region}.amazonaws.com`;
  const path = `/browser-streams/${browserIdentifier}/sessions/${sessionId}/automation`;
  const credentials = await defaultProvider()();
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region,
    credentials,
    sha256: Sha256,
  });
  const signed = await signer.sign(
    new HttpRequest({
      protocol: 'wss:',
      hostname: host,
      path,
      method: 'GET',
      headers: { host },
    }),
  );
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (typeof value === 'string') headers[key] = value;
  }
  return { url: `wss://${host}${path}`, headers };
}
