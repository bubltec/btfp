import { createSignedFetch } from './sigv4-fetch.js';
import type { SearchClient, SearchHit } from './types.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export interface GatewaySearchClientOptions {
  gatewayUrl: string;
  region: string;
  fetchImpl?: typeof fetch;
  toolName?: string;
}

/**
 * Thin MCP JSON-RPC client for an AgentCore Gateway that hosts the managed
 * Web Search connector. No third-party search keys — IAM only.
 */
export function normalizeGatewayUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
}

export class GatewaySearchClient implements SearchClient {
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly toolName: string;
  private nextId = 1;
  private sessionId: string | undefined;
  private initialized = false;

  constructor(options: GatewaySearchClientOptions) {
    this.gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
    this.fetchImpl = options.fetchImpl ?? createSignedFetch(options.region);
    this.toolName = options.toolName ?? 'WebSearch';
  }

  async search(query: string, maxResults: number): Promise<SearchHit[]> {
    await this.ensureInitialized();
    const response = await this.rpc('tools/call', {
      name: this.toolName,
      arguments: { query: query.slice(0, 200), maxResults },
    });
    return parseSearchHits(response);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'btfp-scraper', version: '1.0' },
    });
    this.initialized = true;
  }

  private async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: this.nextId++, method, params };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const response = await this.fetchImpl(this.gatewayUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!response.ok) {
      throw new Error(`Gateway ${method} failed: ${response.status} ${await response.text()}`);
    }

    const payload = await readJsonRpcBody(response);
    if (payload.error) {
      throw new Error(
        `Gateway ${method} error: ${payload.error.message ?? JSON.stringify(payload.error)}`,
      );
    }
    return payload.result;
  }
}

export async function readJsonRpcBody(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('text/event-stream')) {
    return parseSseJsonRpc(text);
  }
  return JSON.parse(text) as JsonRpcResponse;
}

export function parseSseJsonRpc(text: string): JsonRpcResponse {
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const last = dataLines.at(-1);
  if (!last) throw new Error('Gateway SSE response had no data frames');
  return JSON.parse(last) as JsonRpcResponse;
}

export function parseSearchHits(result: unknown): SearchHit[] {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  const textBlock = content?.find((block) => block.type === 'text' && block.text)?.text;
  if (!textBlock) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock);
  } catch {
    return [];
  }

  const rows = (parsed as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return [];

  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title : '';
    const url = typeof item.url === 'string' ? item.url : '';
    const text = typeof item.text === 'string' ? item.text : '';
    if (!title && !text && !url) continue;
    hits.push({
      title,
      url,
      text,
      publishedDate: typeof item.publishedDate === 'string' ? item.publishedDate : undefined,
    });
  }
  return hits;
}
