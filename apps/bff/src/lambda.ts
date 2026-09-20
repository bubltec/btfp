import { FastifyAdapter } from '@nestjs/platform-fastify';
import awsLambdaFastify from '@fastify/aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createApp } from './app.js';
import { requestContext } from './logging/request-context.js';

type Proxy = (event: unknown, context: unknown) => Promise<unknown>;
let proxy: Proxy | undefined;

// GithubStrategy reads GITHUB_CLIENT_SECRET synchronously at construction
// time (during createApp() below), so this has to resolve before that call.
// Only set in envs that actually have a GitHub OAuth app configured — see
// api-stack.ts — everywhere else this is a no-op and the strategy falls
// back to its "not-configured" placeholder as before.
async function loadGithubClientSecret(): Promise<void> {
  const parameterName = process.env.GITHUB_CLIENT_SECRET_PARAM;
  if (!parameterName || process.env.GITHUB_CLIENT_SECRET) return;
  const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const result = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  if (result.Parameter?.Value) process.env.GITHUB_CLIENT_SECRET = result.Parameter.Value;
}

async function bootstrap(): Promise<Proxy> {
  await loadGithubClientSecret();
  const adapter = new FastifyAdapter();
  const app = await createApp(adapter);
  await app.init();
  return awsLambdaFastify(adapter.getInstance()) as Proxy;
}

export const handler = async (event: unknown, context: { awsRequestId?: string }) =>
  requestContext.run({ requestId: context.awsRequestId ?? 'unknown' }, async () => {
    proxy ??= await bootstrap();
    return proxy(event, context);
  });
