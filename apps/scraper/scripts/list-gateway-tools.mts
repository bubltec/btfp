import { GatewaySearchClient } from '../src/search/gateway.js';

const url = process.env.AGENTCORE_GATEWAY_URL;
if (!url) {
  console.error('AGENTCORE_GATEWAY_URL is required');
  process.exit(1);
}

const client = new GatewaySearchClient({
  gatewayUrl: url,
  region: process.env.AWS_REGION ?? 'us-east-1',
});
const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));
