import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

/**
 * AgentCore Gateway inbound auth is AWS_IAM — every MCP HTTP request has to
 * be SigV4-signed for service `bedrock-agentcore`.
 */
export function createSignedFetch(region: string): typeof fetch {
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : typeof init?.body === 'string'
          ? init.body
          : undefined;

    const headers: Record<string, string> = { host: url.host };
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    const signed = await signer.sign(
      new HttpRequest({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        ...(body !== undefined && { body }),
      }),
    );

    return fetch(url, { ...init, method, headers: signed.headers, body });
  };
}
