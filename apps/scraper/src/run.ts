import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ScraperConfig } from './config.js';
import { RedditClient } from './reddit/client.js';
import { classifyPost } from './extract/classify.js';
import { loadTaxonomy, loadThingCatalog } from './taxonomy.js';
import { getWatermark, isAlreadyProcessed, markProcessed, putWatermark } from './dedup.js';
import { writeContribution } from './contribution.js';
import type { RedditPost } from './reddit/types.js';

const MIN_SELFTEXT_LENGTH = 40;

function isWorthClassifying(post: RedditPost): boolean {
  return !post.stickied && post.selftext.trim().length >= MIN_SELFTEXT_LENGTH;
}

/**
 * fetchNewPosts already returns only posts newer than the watermark,
 * oldest-first — so the last element (if any) is always the newest post
 * actually seen this run, regardless of whether it was classified as a
 * hazard report.
 */
export async function run(config: ScraperConfig, db: DynamoDBDocumentClient): Promise<void> {
  if (!config.redditClientId || !config.redditClientSecret) {
    console.log('Reddit credentials not configured, skipping run.');
    return;
  }

  const reddit = new RedditClient({
    clientId: config.redditClientId,
    clientSecret: config.redditClientSecret,
  });
  const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const taxonomy = await loadTaxonomy(db);
  const catalog = await loadThingCatalog(db);

  for (const subreddit of config.subreddits) {
    const watermark = await getWatermark(db, subreddit);
    const posts = await reddit.fetchNewPosts(subreddit, watermark?.lastSeenCreatedUtc);

    let candidateCount = 0;
    for (const post of posts) {
      if (await isAlreadyProcessed(db, post.id)) continue;

      if (isWorthClassifying(post)) {
        const extraction = await classifyPost(
          bedrock,
          config.bedrockInferenceProfileId,
          post,
          taxonomy,
        );
        if (extraction?.isPetHazardReport) {
          await writeContribution(db, post, extraction, catalog);
          candidateCount += 1;
        }
      }
      await markProcessed(db, post.id, subreddit);
    }

    if (posts.length > 0) {
      const newest = posts[posts.length - 1];
      if (newest) await putWatermark(db, subreddit, newest.created_utc, newest.id);
    }

    console.log(`r/${subreddit}: ${posts.length} new posts, ${candidateCount} candidates written.`);
  }
}
