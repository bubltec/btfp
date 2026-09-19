import { loadConfig } from './config.js';
import { createDynamoClient } from './dynamo.js';
import { run } from './run.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDynamoClient();
  await run(config, db);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Scraper run failed:', err);
    process.exitCode = 1;
  });
