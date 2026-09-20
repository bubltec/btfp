import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://vetmeds.org/wp-json/wp/v2';
const SOURCE = 'American College of Veterinary Pharmacists — Pet Poison Control';
const OUTPUT_PATH = path.join(__dirname, '../source/vetmeds-staging.json');
const PAGE_SIZE = 100;
const USER_AGENT = 'badthingsforpets.com data-sourcing script (one-time, low-rate)';

// vetmeds.org's own category taxonomy names, mapped onto this repo's
// thingTypeIds. The human review step (see docs/data-sourcing.md) is the
// place to correct any of these — some entries carry multiple categories
// (e.g. CBD oil is tagged both Herbals and OTC Medications) and this
// script just picks the first.
const CATEGORY_TO_THING_TYPE: Record<string, string> = {
  Food: 'food',
  Plants: 'plant',
  'Household Products': 'product',
  'Human Prescriptions': 'medication',
  'Veterinary Prescriptions': 'medication',
  'OTC Medications': 'medication',
  Herbals: 'medication',
  'Illicit & Recreational Drugs': 'drug',
};

interface WpTerm {
  id: number;
  name: string;
}

interface WpPortfolioEntry {
  id: number;
  title: { rendered: string };
  link: string;
  content: { rendered: string };
  portfolio_category: number[];
}

interface StagingEntry {
  name: string;
  category: string;
  thingTypeId: string;
  // vetmeds.org covers dog + cat in most entries; defaulted to 'unknown'
  // for both here since real severity is a human-review judgment call
  // (see docs/data-sourcing.md), not something this script infers.
  petTypes: { petTypeId: string; severity: 'unknown' }[];
  clinicalSigns?: string;
  toxicDoseSummary?: string;
  source: string;
  sourceUrl: string;
}

const DEFAULT_PET_TYPES: StagingEntry['petTypes'] = [
  { petTypeId: 'dog', severity: 'unknown' },
  { petTypeId: 'cat', severity: 'unknown' },
];

// WP REST API returns names/titles HTML-entity-encoded (e.g. "Illicit
// &amp; Recreational Drugs") — decode before using as a plain string,
// otherwise category-name lookups silently miss.
function decodeEntities(text: string): string {
  return cheerio.load(`<div>${text}</div>`)('div').text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchAllPages<T>(pathAndQuery: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const url = `${API_BASE}${pathAndQuery}${sep}per_page=${PAGE_SIZE}&page=${page}`;
    const batch = await fetchJson<T[]>(url);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}

/**
 * Extracts only short, structured facts from the post's rendered content —
 * not the page's descriptive prose paragraphs verbatim. Matches this
 * repo's existing seed-data shape (toxicPrinciples/clinicalSigns are
 * short factual strings, not copied text) and avoids redistributing
 * vetmeds.org's actual writing.
 */
function extractFacts(contentHtml: string): { clinicalSigns?: string; toxicDoseSummary?: string } {
  const text = cheerio.load(contentHtml)('body').text().replace(/\s+/g, ' ').trim();

  const signsMatch = text.match(/Signs and symptoms of toxicity:\s*([^.]+\.)/i);
  const doseMatch = text.match(/Toxic Consumption:\s*([^.]+\.)/i);

  return {
    clinicalSigns: signsMatch?.[1]?.trim(),
    toxicDoseSummary: doseMatch?.[1]?.trim().slice(0, 300),
  };
}

async function main(): Promise<void> {
  const [terms, entries] = await Promise.all([
    fetchAllPages<WpTerm>('/portfolio_category?_fields=id,name'),
    fetchAllPages<WpPortfolioEntry>(
      '/avada_portfolio?_fields=id,title,link,content,portfolio_category',
    ),
  ]);
  const termNameById = new Map(terms.map((t) => [t.id, decodeEntities(t.name)]));
  console.log(`Found ${entries.length} toxin entries across ${terms.length} categories.`);

  const staging: StagingEntry[] = entries.map((entry) => {
    const categoryName = termNameById.get(entry.portfolio_category[0] ?? -1) ?? 'unknown';
    const { clinicalSigns, toxicDoseSummary } = extractFacts(entry.content.rendered);

    return {
      name: decodeEntities(entry.title.rendered),
      category: categoryName,
      thingTypeId: CATEGORY_TO_THING_TYPE[categoryName] ?? 'unknown',
      petTypes: DEFAULT_PET_TYPES,
      clinicalSigns,
      toxicDoseSummary,
      source: SOURCE,
      sourceUrl: entry.link,
    };
  });

  await writeFile(OUTPUT_PATH, JSON.stringify(staging, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${staging.length} entries to ${OUTPUT_PATH}`);
  console.log(
    'Review and correct category/thingTypeId/severity before promoting to vetmeds-toxins.json.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
