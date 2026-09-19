import { withAgentCorePage } from '../browser/session.js';
import { parseTrendRows } from './parse.js';
import { trendingNowUrl, type TrendSource, type TrendTopic } from './types.js';

export interface GoogleTrendsBrowserSourceOptions {
  region: string;
  geo: string;
  hours: number;
  category: number;
  withPage?: typeof withAgentCorePage;
}

export class GoogleTrendsBrowserSource implements TrendSource {
  constructor(private readonly options: GoogleTrendsBrowserSourceOptions) {}

  async listTrendingTopics(): Promise<TrendTopic[]> {
    const withPage = this.options.withPage ?? withAgentCorePage;
    const url = trendingNowUrl(this.options.geo, this.options.hours, this.options.category);
    const terms = await withPage({ region: this.options.region }, async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page
        .waitForFunction('document.body && document.body.innerText.length > 200', {
          timeout: 20_000,
        })
        .catch(() => undefined);
      const rowTexts = await page.locator('table tbody tr, [role="row"]').allInnerTexts();
      const parsed = parseTrendRows(rowTexts);
      if (parsed.length > 0) return parsed;

      const linkTexts = await page.locator('a').allInnerTexts();
      return parseTrendRows(linkTexts);
    });
    return terms.map((term) => ({ term }));
  }
}
