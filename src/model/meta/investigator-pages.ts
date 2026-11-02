import { object } from './stream.js';
import { MAX_PAGE_URLS, type PageFetchStats } from './page-evidence.js';
import { fetchPage, type PageFetchIo } from './page-fetch.js';

export type StructurePage = { url: string; title: string; text: string };
type Result = { url: string; title: string };

function searchResults(response: Record<string, unknown>): Result[] {
  const items = Array.isArray(response.output) ? response.output : [];
  const results: Result[] = [];
  const cited = new Set<string>();
  for (const raw of items) {
    const item = object(raw);
    if (item?.type === 'web_search_call' && Array.isArray(item.results)) {
      for (const rawResult of item.results) {
        const result = object(rawResult);
        if (typeof result?.url === 'string' && !results.some(entry => entry.url === result.url)) {
          results.push({ url: result.url, title: typeof result.title === 'string' ? result.title : '' });
        }
      }
    }
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const rawPart of item.content) {
      const part = object(rawPart);
      if (part?.type !== 'output_text' || !Array.isArray(part.annotations)) continue;
      for (const rawAnnotation of part.annotations) {
        const annotation = object(rawAnnotation);
        const nested = object(annotation?.url_citation);
        const url = annotation?.url ?? nested?.url;
        if (annotation?.type === 'url_citation' && typeof url === 'string') cited.add(url);
      }
    }
  }
  return [...results.filter(result => cited.has(result.url)), ...results.filter(result => !cited.has(result.url))]
    .slice(0, MAX_PAGE_URLS);
}

// Extracted text has collapsed whitespace; score sentence-like windows as paragraph substitutes.
export function relevantExtract(text: string, query: string, limit: number): string {
  if (text.length <= limit) return text;
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))];
  let best = 0;
  let score = -1;
  for (let offset = 0; offset < text.length; offset += 500) {
    const window = text.slice(offset, offset + limit).toLowerCase();
    const value = terms.reduce((sum, term) => sum + (window.includes(term) ? 1 : 0), 0);
    if (value > score) {
      score = value;
      best = offset;
    }
  }
  return text.slice(best, best + limit);
}

export async function fetchSearchPages(
  response: Record<string, unknown>, query: string, signal: AbortSignal, io: PageFetchIo,
): Promise<{ pages: StructurePage[]; texts: Map<string, string>; stats: PageFetchStats }> {
  const selected = searchResults(response);
  const fetched = await Promise.all(selected.map(result => fetchPage(result.url, signal, io)));
  const stats: PageFetchStats = {
    pagesFetched: fetched.filter(page => page.status === 'fetched').length,
    pagesBlocked: fetched.filter(page => page.status === 'blocked').length,
    pagesFailed: fetched.filter(page => page.status === 'failed').length,
    excerpts: 0,
    claimsWithQuoteOnPage: 0,
    claims: 0,
    pagesGivenToStructure: 0,
    inputChars: 0,
  };
  const pages: StructurePage[] = [];
  const texts = new Map<string, string>();
  let remaining = 20000;
  for (let index = 0; index < selected.length; index++) {
    const result = selected[index]!;
    const page = fetched[index]!;
    if (page.status !== 'fetched') continue;
    texts.set(result.url, page.text);
    const text = relevantExtract(page.text, query, Math.min(4000, remaining));
    if (!text) continue;
    pages.push({ ...result, text });
    remaining -= text.length;
  }
  stats.pagesGivenToStructure = pages.length;
  stats.inputChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  return { pages, texts, stats };
}
