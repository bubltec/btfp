import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SSMClient,
  PutParameterCommand,
  GetParametersByPathCommand,
  GetParameterCommand,
} from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_DEPLOY_LOCAL_PATH = path.join(__dirname, '../.env.deploy.local');
const BFF_ENV_PATH = path.join(__dirname, '../../../apps/bff/.env');
const REGION = 'us-east-1';

// Live, prod-only, not created by CDK (see infra/cdk/lib/config.ts) — read
// here, never written, so this script can't touch working prod OAuth.
const GITHUB_CLIENT_SECRET_PARAM = '/btfp/github-client-secret';

type Env = 'dev' | 'prod';

interface SecretMapping {
  scope: Env | 'shared';
  ssmName: string;
  cdkVar: string;
  /** Only synced into apps/bff/.env, and only for `dev`. */
  bffVar?: string;
}

const MAPPINGS: SecretMapping[] = [
  { scope: 'dev', ssmName: '/btfp/dev/basic-auth-user', cdkVar: 'BTFP_DEV_BASIC_AUTH_USER' },
  {
    scope: 'dev',
    ssmName: '/btfp/dev/basic-auth-password',
    cdkVar: 'BTFP_DEV_BASIC_AUTH_PASSWORD',
  },
  {
    scope: 'dev',
    ssmName: '/btfp/dev/jwt-secret',
    cdkVar: 'BTFP_DEV_JWT_SECRET',
    bffVar: 'JWT_SECRET',
  },
  { scope: 'prod', ssmName: '/btfp/prod/jwt-secret', cdkVar: 'BTFP_PROD_JWT_SECRET' },
  {
    scope: 'shared',
    ssmName: '/btfp/shared/brave-search-api-key',
    cdkVar: 'BTFP_BRAVE_SEARCH_API_KEY',
  },
];

function mappingsForEnv(env: Env): SecretMapping[] {
  return MAPPINGS.filter((m) => m.scope === env || m.scope === 'shared');
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || value.startsWith('REPLACE_');
}

function setEnvLine(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
}

async function requireCallerIdentity(): Promise<void> {
  try {
    await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
  } catch {
    console.error(
      'Not authenticated with AWS. Run `aws sso login --profile <your-profile>` first (see docs/infra.md), then retry.',
    );
    process.exit(1);
  }
}

async function push(env: Env): Promise<void> {
  await requireCallerIdentity();
  const local = parseEnvFile(ENV_DEPLOY_LOCAL_PATH);
  const ssm = new SSMClient({ region: REGION });
  const written: string[] = [];

  for (const mapping of mappingsForEnv(env)) {
    const value = local[mapping.cdkVar];
    if (isPlaceholder(value)) continue;
    await ssm.send(
      new PutParameterCommand({
        Name: mapping.ssmName,
        Value: value,
        Type: 'SecureString',
        Overwrite: true,
      }),
    );
    written.push(mapping.ssmName);
  }

  if (written.length === 0) {
    console.log(
      `Nothing to push for ${env} — infra/cdk/.env.deploy.local has no real values set for its keys.`,
    );
    return;
  }
  console.log(`Pushed to SSM (${env}):`);
  for (const name of written) console.log(`  ${name}`);
}

async function sync(env: Env): Promise<void> {
  await requireCallerIdentity();
  const ssm = new SSMClient({ region: REGION });
  const values = new Map<string, string>();

  for (const prefix of [`/btfp/${env}/`, '/btfp/shared/']) {
    let nextToken: string | undefined;
    do {
      const result = await ssm.send(
        new GetParametersByPathCommand({
          Path: prefix,
          Recursive: true,
          WithDecryption: true,
          NextToken: nextToken,
        }),
      );
      for (const param of result.Parameters ?? []) {
        if (param.Name && param.Value) values.set(param.Name, param.Value);
      }
      nextToken = result.NextToken;
    } while (nextToken);
  }

  let githubClientSecret: string | undefined;
  if (env === 'dev') {
    try {
      const result = await ssm.send(
        new GetParameterCommand({ Name: GITHUB_CLIENT_SECRET_PARAM, WithDecryption: true }),
      );
      githubClientSecret = result.Parameter?.Value;
    } catch {
      // Not created yet, or no permission — sync just skips it.
    }
  }

  // Merge onto the existing file rather than overwriting it — .env.deploy.local
  // holds keys this script doesn't manage (BTFP_HOSTED_ZONE_ID) and the *other*
  // env's secrets (syncing dev shouldn't erase BTFP_PROD_JWT_SECRET). Only the
  // keys this env actually maps get touched; everything else survives.
  let cdkContent = existsSync(ENV_DEPLOY_LOCAL_PATH)
    ? readFileSync(ENV_DEPLOY_LOCAL_PATH, 'utf-8')
    : '';
  let written = 0;
  for (const mapping of mappingsForEnv(env)) {
    const value = values.get(mapping.ssmName);
    if (!value) continue;
    cdkContent = setEnvLine(cdkContent, mapping.cdkVar, value);
    written++;
  }
  writeFileSync(ENV_DEPLOY_LOCAL_PATH, cdkContent);
  console.log(`Updated ${written} values in infra/cdk/.env.deploy.local`);

  if (env === 'dev' && existsSync(BFF_ENV_PATH)) {
    let bffContent = readFileSync(BFF_ENV_PATH, 'utf-8');
    const jwtSecret = values.get('/btfp/dev/jwt-secret');
    if (jwtSecret) bffContent = setEnvLine(bffContent, 'JWT_SECRET', jwtSecret);
    if (githubClientSecret)
      bffContent = setEnvLine(bffContent, 'GITHUB_CLIENT_SECRET', githubClientSecret);
    writeFileSync(BFF_ENV_PATH, bffContent);
    console.log('Updated JWT_SECRET / GITHUB_CLIENT_SECRET in apps/bff/.env');
  }
}

async function main(): Promise<void> {
  const [command, envArg] = process.argv.slice(2);
  const usage = 'Usage: tsx scripts/secrets.ts <push|sync> <dev|prod>';

  if (command !== 'push' && command !== 'sync') {
    console.error(usage);
    process.exit(1);
  }
  if (envArg !== 'dev' && envArg !== 'prod') {
    console.error(usage);
    process.exit(1);
  }

  if (command === 'push') await push(envArg);
  else await sync(envArg);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
