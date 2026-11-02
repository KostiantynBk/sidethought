import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchContext } from '../src/context/research.js';
import { addPageEvidence } from '../src/model/meta/page-evidence.js';
import { extractPageText } from '../src/model/meta/page-text.js';
import { ResearchHarness } from './t11a-helpers.js';
import { emptyEvidence, fakePageIo, pageLimits, pageOutput, pageQuote, pageUrl } from './t14-page-helpers.js';

const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe('T14 bounded evidence assembly', () => {
  it('fetches no more than six distinct cited URLs in parallel', async () => {
    const urls = Array.from({ length: 8 }, (_, index) => `https://provider.example/${index}`);
    const fake = fakePageIo([{ hang: true }]);
    const evidence = emptyEvidence(urls);
    const result = addPageEvidence(pageOutput(urls), evidence, pageLimits, signal(), fake.io);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(6));
    for (const request of fake.requests) request.release!();
    const stats = await result;
    expect(fake.requests.map(request => request.url)).toEqual(urls.slice(0, 6));
    expect(stats.pagesFetched).toBe(6);
    expect(stats.excerpts).toBe(6);
    expect(stats.claimsWithQuoteOnPage).toBe(6);
    expect(stats.claims).toBe(8);
  });

  it('fetches a repeated citation only once while allowing separate excerpts', async () => {
    const fake = fakePageIo();
    const evidence = emptyEvidence();
    const stats = await addPageEvidence(pageOutput([pageUrl, pageUrl]), evidence, pageLimits, signal(), fake.io);
    expect(fake.requests).toHaveLength(1);
    expect(stats.excerpts).toBe(2);
    expect(stats.claimsWithQuoteOnPage).toBe(2);
  });

  it('preserves the original Meta result byte-for-byte after the verifiable excerpt', async () => {
    const fake = fakePageIo();
    const evidence = emptyEvidence();
    const original = structuredClone(evidence.results[0]);
    await addPageEvidence(pageOutput(), evidence, pageLimits, signal(), fake.io);
    expect(evidence.results[0]).toEqual({
      url: pageUrl,
      title: 'Public documentation',
      snippet: pageQuote,
    });
    expect(evidence.results[1]).toEqual(original);
  });

  it('never exceeds maxEvidenceResults and gives excerpts priority over URL-only results', async () => {
    const fake = fakePageIo();
    const evidence = emptyEvidence();
    const limits = { ...pageLimits, maxEvidenceResults: 2 };
    const stats = await addPageEvidence(pageOutput([pageUrl, pageUrl]), evidence, limits, signal(), fake.io);
    expect(evidence.results).toHaveLength(2);
    expect(evidence.results.map(result => result.snippet)).toEqual([pageQuote, pageQuote]);
    expect(stats.excerpts).toBe(2);
  });

  it('replaces a URL-only Meta result with a verifiable excerpt when every slot is occupied', async () => {
    const fake = fakePageIo();
    const evidence = emptyEvidence();
    const limits = { ...pageLimits, maxEvidenceResults: 1 };
    const stats = await addPageEvidence(pageOutput(), evidence, limits, signal(), fake.io);
    expect(evidence.results).toEqual([{ url: pageUrl, title: 'Public documentation', snippet: pageQuote }]);
    expect(stats.excerpts).toBe(1);
    expect(stats.claimsWithQuoteOnPage).toBe(1);
  });

  it('keeps Meta results that carry text ahead of excerpts', async () => {
    const fake = fakePageIo();
    const evidence = emptyEvidence();
    evidence.results[0]!.snippet = 'Meta text';
    const limits = { ...pageLimits, maxEvidenceResults: 1 };
    const stats = await addPageEvidence(pageOutput(), evidence, limits, signal(), fake.io);
    expect(evidence.results.map(result => result.snippet)).toEqual(['Meta text']);
    expect(stats.excerpts).toBe(0);
  });

  it('still adds excerpts when twenty empty Meta results fill the cap, as observed live', async () => {
    const fake = fakePageIo();
    const urls = [pageUrl, ...Array.from({ length: 19 }, (_, index) => `https://other.example/${index}`)];
    const evidence = emptyEvidence([...urls]);
    evidence.results.push(...structuredClone(evidence.results.slice(0, 5)));
    const stats = await addPageEvidence(pageOutput(), evidence, pageLimits, signal(), fake.io);
    expect(evidence.results).toHaveLength(20);
    expect(evidence.results[0]).toEqual({ url: pageUrl, title: 'Public documentation', snippet: pageQuote });
    expect(new Set(evidence.results.slice(1).map(result => result.url)).size).toBe(19);
    expect(stats.excerpts).toBe(1);
  });

  it('adds no excerpt after a page timeout', async () => {
    vi.useFakeTimers();
    const fake = fakePageIo([{ hang: true }]);
    const evidence = emptyEvidence();
    const result = addPageEvidence(pageOutput(), evidence, pageLimits, signal(), fake.io);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).pagesFailed).toBe(1);
    expect(evidence.results).toHaveLength(1);
  });

  it('counts blocked and failed pages separately without returning URLs or text in stats', async () => {
    const urls = [pageUrl, 'http://127.0.0.1/', 'https://broken.example/'];
    const fake = fakePageIo([{}, { error: true }]);
    const evidence = emptyEvidence(urls);
    const stats = await addPageEvidence(pageOutput(urls), evidence, pageLimits, signal(), fake.io);
    expect(stats).toEqual({
      pagesFetched: 1,
      pagesBlocked: 1,
      pagesFailed: 1,
      excerpts: 1,
      claimsWithQuoteOnPage: 1,
      claims: 3,
    });
    expect(Object.values(stats).every(value => typeof value === 'number')).toBe(true);
  });

  it('does not use one URL page text for another URL claim', async () => {
    const urls = [pageUrl, 'https://other.example/'];
    const fake = fakePageIo([{}, { body: '<p>Unrelated source</p>' }]);
    const evidence = emptyEvidence(urls);
    await addPageEvidence(pageOutput(urls), evidence, pageLimits, signal(), fake.io);
    expect(evidence.results.filter(result => result.snippet)).toHaveLength(1);
    expect(evidence.results.find(result => result.snippet)!.url).toBe(pageUrl);
  });
});

describe('T14 real-kernel support verification', () => {
  let harness: ResearchHarness;
  afterEach(() => harness?.store.close());

  it('verifies a consistent claim using an exact fetched-page substring', async () => {
    const body = `<head>Not evidence</head><p>Intro</p><p>${pageQuote}</p><p>End</p>`;
    const fake = fakePageIo([{ body }]);
    const evidence = emptyEvidence();
    const output = pageOutput();
    await addPageEvidence(output, evidence, pageLimits, signal(), fake.io);
    harness = new ResearchHarness('sqlite');
    harness.request();
    harness.send('job.completed', {
      jobId: Object.values(harness.state.domain.jobs)[0]!.id,
      callId: Object.values(harness.state.domain.jobs)[0]!.callId,
      investigatorOutput: output,
      retrievalEvidence: evidence,
    });
    const finding = Object.values(harness.state.domain.findings)[0]!;
    expect(finding.claims[0]!.support[0]!.quoteVerified).toBe(true);
    expect(extractPageText(body, 'text/html').includes(finding.retrievalEvidence.results[1]!.snippet)).toBe(true);
    expect(finding.retrievalEvidence).toEqual(evidence);
    expect(researchContext(harness.state).findings[0]!.claims).toHaveLength(1);
  });

  it('keeps a quote absent from the page citation-only', async () => {
    const fake = fakePageIo([{ body: '<p>Provider A supports 5 users</p>' }]);
    const evidence = emptyEvidence();
    const output = pageOutput();
    const stats = await addPageEvidence(output, evidence, pageLimits, signal(), fake.io);
    harness = new ResearchHarness('memory');
    harness.request();
    harness.send('job.completed', {
      jobId: Object.values(harness.state.domain.jobs)[0]!.id,
      callId: Object.values(harness.state.domain.jobs)[0]!.callId,
      investigatorOutput: output,
      retrievalEvidence: evidence,
    });
    const finding = Object.values(harness.state.domain.findings)[0]!;
    expect(finding.claims[0]!.support[0]!.quoteVerified).toBe(false);
    expect(researchContext(harness.state).findings[0]!.claims).toEqual([]);
    expect(stats.excerpts).toBe(0);
    expect(stats.claimsWithQuoteOnPage).toBe(0);
  });

  it('still requires consistency even when the quote is fetched', async () => {
    const fake = fakePageIo();
    const evidence = emptyEvidence();
    const output = pageOutput();
    output.claims[0]!.text = 'Provider A supports 15 users';
    await addPageEvidence(output, evidence, pageLimits, signal(), fake.io);
    harness = new ResearchHarness('memory');
    harness.request();
    harness.send('job.completed', {
      jobId: Object.values(harness.state.domain.jobs)[0]!.id,
      callId: Object.values(harness.state.domain.jobs)[0]!.callId,
      investigatorOutput: output,
      retrievalEvidence: evidence,
    });
    expect(Object.values(harness.state.domain.findings)[0]!.claims[0]!.support[0]!.quoteVerified).toBe(false);
  });

  it('does not turn a no-search result into researched evidence', async () => {
    const fake = fakePageIo();
    const evidence = { ...emptyEvidence(), completedSearchCalls: 0 };
    const output = pageOutput();
    await addPageEvidence(output, evidence, pageLimits, signal(), fake.io);
    harness = new ResearchHarness('memory');
    harness.request();
    harness.send('job.completed', {
      jobId: Object.values(harness.state.domain.jobs)[0]!.id,
      callId: Object.values(harness.state.domain.jobs)[0]!.callId,
      investigatorOutput: output,
      retrievalEvidence: evidence,
    });
    const finding = Object.values(harness.state.domain.findings)[0]!;
    expect(finding.verdict).toBe('not_researched');
    expect(finding.claims[0]!.support[0]!.quoteVerified).toBe(false);
  });
});
