import { describe, expect, it, vi } from 'vitest';
import {
  GatewaySearchClient,
  normalizeGatewayUrl,
  parseSearchHits,
  parseSseJsonRpc,
} from './gateway.js';

const samplePayload = {
  id: '824f89d0',
  results: [
    {
      text: 'Xylitol is highly toxic to dogs.',
      publishedDate: '2024-10-07',
      url: 'https://example.com/xylitol',
      title: 'Xylitol poisoning',
    },
  ],
};

describe('parseSearchHits', () => {
  it('reads the MCP text-block JSON results', () => {
    expect(
      parseSearchHits({
        content: [{ type: 'text', text: JSON.stringify(samplePayload) }],
      }),
    ).toEqual([
      {
        title: 'Xylitol poisoning',
        url: 'https://example.com/xylitol',
        text: 'Xylitol is highly toxic to dogs.',
        publishedDate: '2024-10-07',
      },
    ]);
  });

  it('returns an empty list when the tool result is malformed', () => {
    expect(parseSearchHits({ content: [{ type: 'text', text: 'not-json' }] })).toEqual([]);
    expect(parseSearchHits({})).toEqual([]);
  });
});

describe('parseSseJsonRpc', () => {
  it('takes the last data frame', () => {
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":false}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(parseSseJsonRpc(sse)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });
});

describe('normalizeGatewayUrl', () => {
  it('appends /mcp when CloudFormation only returns the origin', () => {
    expect(normalizeGatewayUrl('https://gw.example')).toBe('https://gw.example/mcp');
    expect(normalizeGatewayUrl('https://gw.example/mcp/')).toBe('https://gw.example/mcp');
  });
});

describe('GatewaySearchClient', () => {
  it('initializes once then calls WebSearch with a truncated query', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }),
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result:
              body.method === 'tools/call'
                ? { content: [{ type: 'text', text: JSON.stringify(samplePayload) }] }
                : { protocolVersion: '2024-11-05' },
          }),
      } as Response;
    });

    const client = new GatewaySearchClient({
      gatewayUrl: 'https://gw.example/mcp',
      region: 'us-east-1',
      fetchImpl,
      toolName: 'WebSearch',
    });
    const hits = await client.search('a'.repeat(250), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('Xylitol poisoning');

    const bodies = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies[0].method).toBe('initialize');
    expect(bodies[1].method).toBe('tools/call');
    expect(bodies[1].params.arguments.query).toHaveLength(200);
    expect(bodies[1].params.arguments.maxResults).toBe(5);

    await client.search('second', 3);
    const methods = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)).method,
    );
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1);
  });

  it('discovers the search tool name from tools/list when it is not WebSearch', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      let result: unknown = { protocolVersion: '2024-11-05' };
      if (body.method === 'tools/list') {
        result = { tools: [{ name: 'web_search' }] };
      } else if (body.method === 'tools/call') {
        result = { content: [{ type: 'text', text: JSON.stringify(samplePayload) }] };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      } as Response;
    });

    const client = new GatewaySearchClient({
      gatewayUrl: 'https://gw.example/mcp',
      region: 'us-east-1',
      fetchImpl,
    });
    await client.search('xylitol', 3);

    const calls = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(calls.some((body) => body.method === 'tools/list')).toBe(true);
    const call = calls.find((body) => body.method === 'tools/call');
    expect(call.params.name).toBe('web_search');
  });
});
