import { loadConfig } from './config.js';
import { createDynamoClient } from './dynamo.js';
import { AgentCoreMemoryStore } from './memory/agentcore.js';
import { backfillMemory } from './memory/backfill.js';
import { run } from './run.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDynamoClient();
  // One-off maintenance run, started by hand with this variable set (docs/scraper.md).
  if (process.env.SCRAPER_BACKFILL_MEMORY === '1') {
    if (!config.agentCoreMemoryId) throw new Error('AGENTCORE_MEMORY_ID is required to backfill');
    const memory = new AgentCoreMemoryStore({ memoryId: config.agentCoreMemoryId });
    const { written, skipped } = await backfillMemory(db, memory);
    console.log(`Memory backfill: ${written} records written, ${skipped} markers skipped.`);
    return;
  }
  await run(config, db);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Scraper run failed:', err);
    process.exitCode = 1;
  });
