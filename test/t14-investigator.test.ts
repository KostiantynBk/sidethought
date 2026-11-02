import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { InvestigatorOutput } from '../src/contract/index.js';
import { initialState } from '../src/kernel/index.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { MetaInvestigator } from '../src/model/meta/investigator.js';
import type { PageFetchStats } from '../src/model/meta/page-evidence.js';
import { PAGE_USER_AGENT } from '../src/model/meta/page-http.js';
import type { RawEvent } from '../src/runtime/model-port.js';
import { sentinel, sse } from './t09-helpers.js';
import { ResearchHarness } from './t11a-helpers.js';
import { fakePageIo, pageOutput, pageQuote, pageUrl } from './t14-page-helpers.js';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function metaFetch(output: InvestigatorOutput): typeof globalThis.fetch {
  let calls = 0;
  return vi.fn<typeof globalThis.fetch>(async url => {
    if (String(url).endsWith('/cancel')) return json({ id: 'response-1', status: 'cancelled' });
    calls++;
    if (calls > 1) return sse([
      { type: 'response.output_text.delta', delta: JSON.stringify(output) },
      { type: 'response.completed' },
    ]);
    return json({
      id: 'response-1',
      status: 'completed',
      output: [{
        type: 'web_search_call',
        status: 'completed',
        action: { query: 'public query' },
        results: [{ url: pageUrl, snippet: '' }],
      }],
    });
  });
}

function setup(fake = fakePageIo(), output: InvestigatorOutput = pageOutput(), harness?: ResearchHarness) {
  const meta = modelConfiguration({ MODEL_API_KEY: sentinel }).meta!;
  const stages: string[] = [];
  let pageStats: PageFetchStats | undefined;
  const model = new MetaInvestigator(
    meta.createClient(metaFetch(output)), meta.prices, () => ({ publicQuery: 'public query' }),
    (stage, stats) => {
      stages.push(stage);
      if (stats) pageStats = stats;
    }, fake.io);
  const emitted: RawEvent[] = [];
  const state = harness?.state ?? initialState('test', loadConfig());
  const context = {
    state,
    emit: (event: RawEvent) => {
      emitted.push(event);
      harness?.send(event.type, event.payload as object);
    },
  };
  const job = harness && Object.values(harness.state.domain.jobs)[0]!;
  const effect = {
    type: 'job.dispatch' as const,
    jobId: job?.id ?? 'job',
    callId: job?.callId ?? 'call',
    capturedInputs: [],
  };
  return { model, context, effect, emitted, stages, stats: () => pageStats, fake };
}

function seedPrivateContext(test: ReturnType<typeof setup>): void {
  test.context.state.domain.inputs.push({
    id: 'input',
    text: 'PRIVATE USER TEXT 9182',
    status: 'interpreted',
  });
  test.context.state.domain.pendingRequests.push({
    inputId: 'input',
    question: 'PRIVATE PROJECT QUESTION 9182',
    publicQuery: 'public query',
    deps: [],
    depItemIds: [],
    promised: true,
  });
}

afterEach(() => vi.useRealTimers());

describe('T14 Investigator page stage', () => {
  it('emits page timing and counts before completing through the real kernel', async () => {
    const harness = new ResearchHarness('sqlite');
    harness.request();
    const test = setup(fakePageIo(), pageOutput(), harness);
    try {
      test.model.handle(test.effect, test.context);
      await vi.waitFor(() => expect(test.emitted.at(-1)?.type).toBe('job.completed'));
      expect(test.stages).toEqual(['responseId', 'searchDone', 'pagesFetched', 'structureDone']);
      expect(test.stats()).toEqual({
        pagesFetched: 1,
        pagesBlocked: 0,
        pagesFailed: 0,
        excerpts: 1,
        claimsWithQuoteOnPage: 1,
        claims: 1,
        pagesGivenToStructure: 1,
        inputChars: expect.any(Number),
      });
      const finding = Object.values(harness.state.domain.findings)[0]!;
      expect(finding.claims[0]!.support[0]!.quoteVerified).toBe(true);
      expect(finding.retrievalEvidence.results[0]!.snippet).toBe(pageQuote);
    } finally {
      await test.model.shutdown();
      harness.store.close();
    }
  });

  it('finishes with citation-only evidence when a page fails', async () => {
    const test = setup(fakePageIo([{ error: true }]));
    test.model.handle(test.effect, test.context);
    await vi.waitFor(() => expect(test.emitted.at(-1)?.type).toBe('job.completed'));
    expect(test.emitted.at(-1)!.payload).toMatchObject({
      retrievalEvidence: { results: [{ url: pageUrl, snippet: '' }] },
    });
    expect(test.stats()!.pagesFailed).toBe(1);
    expect(test.stats()!.excerpts).toBe(0);
    expect(test.emitted.some(event => event.type === 'job.failed')).toBe(false);
    await test.model.shutdown();
  });

  it('cancels all ongoing page fetches and emits nothing after job.cancelled', async () => {
    const fake = fakePageIo([{ hang: true }]);
    const test = setup(fake);
    test.model.handle(test.effect, test.context);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    test.model.handle({ type: 'job.abort', callId: test.effect.callId }, test.context);
    await vi.waitFor(() => expect(test.emitted.at(-1)?.type).toBe('job.cancelled'));
    const eventsAtCancel = structuredClone(test.emitted);
    for (const request of fake.requests) request.release!();
    await test.model.shutdown();
    expect(test.emitted).toEqual(eventsAtCancel);
    expect(fake.requests.every(request => request.req.destroyed && request.response!.destroyed)).toBe(true);
    expect(test.stages).not.toContain('pagesFetched');
    expect(test.emitted.filter(event => event.type.startsWith('job.')).map(event => event.type))
      .toEqual(['job.started', 'job.cancelled']);
  });

  it('uses the existing job deadline to abort the page stage and emit job.timedOut', async () => {
    vi.useFakeTimers();
    const fake = fakePageIo([{ hang: true }]);
    const test = setup(fake);
    test.context.state.config.jobDeadlineMs = 1000;
    test.model.handle(test.effect, test.context);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1000);
    await test.model.shutdown();
    expect(fake.requests[0]!.req.destroyed).toBe(true);
    expect(fake.requests[0]!.response!.destroyed).toBe(true);
    expect(test.emitted.filter(event => event.type.startsWith('job.')).map(event => event.type))
      .toEqual(['job.started', 'job.timedOut']);
    expect(test.stages).not.toContain('pagesFetched');
  });

  it('sends only the cited URL and fixed headers, never project, user or quote text', async () => {
    const fake = fakePageIo([
      { status: 302, headers: { location: '/canonical', 'set-cookie': ['secret-cookie=value'] } },
      {},
    ]);
    const output = pageOutput();
    output.claims[0]!.support[0]!.quote = 'PRIVATE QUOTE 9182';
    output.claims[0]!.support[0]!.title = 'PRIVATE TITLE 9182';
    const test = setup(fake, output);
    seedPrivateContext(test);
    test.model.handle(test.effect, test.context);
    await vi.waitFor(() => expect(test.emitted.at(-1)?.type).toBe('job.completed'));
    expect(fake.requests.map(request => request.url)).toEqual([pageUrl, 'https://provider.example/canonical']);
    for (const request of fake.requests) {
      expect(request.options.headers).toEqual({
        'User-Agent': PAGE_USER_AGENT,
        'Accept': 'text/html, application/xhtml+xml, text/plain',
        'Accept-Encoding': 'identity',
      });
      expect(request.options.method).toBe('GET');
      expect(request.options.auth).toBeUndefined();
      expect(JSON.stringify({ url: request.url, options: request.options })).not.toContain('9182');
      expect(JSON.stringify(request.options)).not.toContain(sentinel);
      expect(JSON.stringify(request.options)).not.toContain('secret-cookie');
    }
    await test.model.shutdown();
  });
});
