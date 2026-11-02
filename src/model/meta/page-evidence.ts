import type { InvestigatorOutput, RetrievalEvidence } from '../../contract/index.js';
import { normalizeEvidence } from '../../kernel/research/support.js';
import { defaultPageFetchIo, fetchPage, type PageFetchIo } from './page-fetch.js';

export const MAX_PAGE_URLS = 6;
export type PageEvidenceLimits = {
  maxSnippetChars: number;
  maxEvidenceResults: number;
};
export type PageFetchStats = {
  pagesFetched: number;
  pagesBlocked: number;
  pagesFailed: number;
  excerpts: number;
  claimsWithQuoteOnPage: number;
  claims: number;
};

function sourceOffset(text: string, normalizedOffset: number): number {
  // Locate an offset using the kernel normalizer itself. NFKC can expand/compose characters,
  // so normalized string offsets must never be used directly to slice the original page.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (normalizeEvidence(text.slice(0, middle)).length < normalizedOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function pageExcerpt(text: string, quote: string, maxChars: number): string | undefined {
  const normalized = normalizeEvidence(quote);
  if (!normalized) return undefined;
  const index = normalizeEvidence(text).indexOf(normalized);
  if (index < 0) return undefined;
  // Include adjacent code units for composition/trim boundary effects; verify the final slice too.
  let start = Math.max(0, sourceOffset(text, index) - 2);
  let end = Math.min(text.length, sourceOffset(text, index + normalized.length) + 2);
  while (start < end && normalizeEvidence(text.slice(start + 1, end)).includes(normalized)) start++;
  while (end > start && normalizeEvidence(text.slice(start, end - 1)).includes(normalized)) end--;
  if (end - start > maxChars) return undefined;
  const spare = maxChars - (end - start);
  const before = Math.min(300, Math.floor(spare / 2));
  const after = Math.min(300, spare - before);
  const snippet = text.slice(Math.max(0, start - before), Math.min(text.length, end + after));
  // Conservative fallback: never synthesize, normalize or patch the retained source text.
  return normalizeEvidence(snippet).includes(normalized) ? snippet : undefined;
}

export async function addPageEvidence(
  output: InvestigatorOutput,
  evidence: RetrievalEvidence,
  limits: PageEvidenceLimits,
  signal: AbortSignal,
  io: PageFetchIo = defaultPageFetchIo,
): Promise<PageFetchStats> {
  const urls = [...new Set(output.claims.flatMap(claim => claim.support.map(support => support.url)))];
  const selected = urls.slice(0, MAX_PAGE_URLS);
  const pages = await Promise.all(selected.map(url => fetchPage(url, signal, io)));
  const stats: PageFetchStats = {
    pagesFetched: pages.filter(page => page.status === 'fetched').length,
    pagesBlocked: pages.filter(page => page.status === 'blocked').length,
    pagesFailed: pages.filter(page => page.status === 'failed').length,
    excerpts: 0,
    claimsWithQuoteOnPage: 0,
    claims: output.claims.length,
  };
  if (signal.aborted) return stats;
  const texts = new Map(selected.flatMap((url, index) => {
    const page = pages[index]!;
    return page.status === 'fetched' ? [[url, page.text] as const] : [];
  }));
  appendExcerpts(output, evidence, texts, limits, stats);
  return stats;
}

function appendExcerpts(
  output: InvestigatorOutput,
  evidence: RetrievalEvidence,
  texts: Map<string, string>,
  limits: PageEvidenceLimits,
  stats: PageFetchStats,
): void {
  for (const claim of output.claims) {
    let matched = false;
    for (const support of claim.support) {
      const text = texts.get(support.url);
      if (text === undefined) continue;
      const quote = normalizeEvidence(support.quote);
      if (!quote || !normalizeEvidence(text).includes(quote)) continue;
      matched = true;
      if (evidence.results.length >= limits.maxEvidenceResults) continue;
      const snippet = pageExcerpt(text, support.quote, limits.maxSnippetChars);
      if (snippet === undefined) continue;
      evidence.results.push({
        url: support.url,
        ...(support.title ? { title: support.title } : {}),
        snippet,
      });
      stats.excerpts++;
    }
    if (matched) stats.claimsWithQuoteOnPage++;
  }
}
