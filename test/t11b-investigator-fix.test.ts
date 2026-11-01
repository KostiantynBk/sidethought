import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { MetaInvestigator } from '../src/model/meta/investigator.js';
import type { RawEvent } from '../src/runtime/model-port.js';
import { sentinel, sse } from './t09-helpers.js';

const result = { verdict: 'inconclusive', claims: [], caveats: [] };

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function setup(fetch: typeof globalThis.fetch) {
  const meta = modelConfiguration({ MODEL_API_KEY: sentinel }).meta!;
  const model = new MetaInvestigator(meta.createClient(fetch), meta.prices, () => ({ publicQuery: 'public query' }));
  const emitted: RawEvent[] = [];
  const state = initialState('session', loadConfig());
  const context = { state, emit: (event: RawEvent) => emitted.push(event) };
  const effect = { type: 'job.dispatch' as const, jobId: 'job', callId: 'call', capturedInputs: [] };
  return { model, emitted, context, effect };
}

function completedStream(): Response {
  return sse([
    { type: 'response.output_text.delta', delta: JSON.stringify(result) },
    { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 10 } } },
  ]);
}

async function waitForEvent(events: RawEvent[], type: string): Promise<void> {
  await vi.waitFor(() => expect(events.some(event => event.type === type)).toBe(true));
}

describe('Investigator fix coverage', () => {
  it('sends neither the actual private question nor project item in any request body', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(String(init?.body ?? ''));
      return bodies.length === 1
        ? json({ id: 'response-1', status: 'completed', output: [] })
        : completedStream();
    });
    const test = setup(fetch);
    test.context.state.domain.pendingRequests.push({
      inputId: 'input',
      question: 'SECRET PRIVATE QUESTION 9182',
      publicQuery: 'public query',
      depItemIds: [],
      deps: [],
      promised: true,
    });
    test.context.state.domain.items.item = {
      id: 'item',
      kind: 'requirement',
      status: 'stated',
      text: 'SECRET PROJECT TEXT 9182',
      contentVersion: 1,
      private: true,
      provenance: { origin: 'user', quoteSpans: [] },
      voiceConfirmNeeded: false,
    };
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.completed');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('public query');
    for (const body of bodies) {
      expect(body).not.toContain('SECRET PRIVATE QUESTION 9182');
      expect(body).not.toContain('SECRET PROJECT TEXT 9182');
    }
    await test.model.shutdown();
  });

  it('aborts a stalled start at the deadline and shutdown finishes', async () => {
    let aborted = false;
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const test = setup(fetch);
    test.context.state.config.jobDeadlineMs = 50;
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.timedOut');
    await test.model.shutdown();
    expect(aborted).toBe(true);
    expect(test.emitted.filter(event => event.type.startsWith('job.')).map(event => event.type))
      .toEqual(['job.timedOut']);
  });

  it('cancels a late response ID after a before-ID deadline', async () => {
    let release!: (response: unknown) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    const cancel = vi.fn(async () => ({}));
    const client = { responses: { create: () => delayed, cancel } } as unknown as OpenAI;
    const meta = modelConfiguration({ MODEL_API_KEY: sentinel }).meta!;
    const model = new MetaInvestigator(client, meta.prices, () => ({ publicQuery: 'public query' }));
    const emitted: RawEvent[] = [];
    const state = initialState('session', loadConfig());
    state.config.jobDeadlineMs = 50;
    const context = { state, emit: (event: RawEvent) => emitted.push(event) };
    const effect = { type: 'job.dispatch' as const, jobId: 'job', callId: 'call', capturedInputs: [] };
    model.handle(effect, context);
    await waitForEvent(emitted, 'job.timedOut');
    release({ id: 'response-1', status: 'queued' });
    await model.shutdown();
    expect(cancel).toHaveBeenCalledExactlyOnceWith('response-1');
    expect(emitted.filter(event => event.type.startsWith('job.')).map(event => event.type))
      .toEqual(['job.timedOut']);
  });

  it.each(['failed', 'incomplete', 'cancelled', 'unknown'])('fails on background terminal %s', async status => {
    let count = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      count++;
      return json({ id: 'response-1', status: count === 1 ? 'queued' : status });
    });
    const test = setup(fetch);
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.failed');
    expect(test.emitted.some(event => event.type === 'job.completed')).toBe(false);
    await test.model.shutdown();
  });

  it.each([400, 503])('reports HTTP %s during background polling', async status => {
    let count = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      count++;
      return count === 1
        ? json({ id: 'response-1', status: 'queued' })
        : new Response('provider error', { status });
    });
    const test = setup(fetch);
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.failed');
    expect(test.emitted.at(-1)?.payload).toMatchObject({
      reason: status === 503 ? 'transient_provider_failure' : 'permanent_provider_failure',
    });
    await test.model.shutdown();
  });

  it.each([400, 503])('reports HTTP %s during structure creation', async status => {
    let count = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      count++;
      return count === 1
        ? json({ id: 'response-1', status: 'completed', output: [] })
        : new Response('provider error', { status });
    });
    const test = setup(fetch);
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.failed');
    expect(test.emitted.at(-1)?.payload).toMatchObject({
      reason: status === 503 ? 'transient_provider_failure' : 'permanent_provider_failure',
    });
    await test.model.shutdown();
  });

  it('polls through in_progress and completes', async () => {
    let count = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      count++;
      if (count === 1) return json({ id: 'response-1', status: 'in_progress' });
      if (count === 2) return json({ id: 'response-1', status: 'completed', output: [] });
      return completedStream();
    });
    const test = setup(fetch);
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.completed');
    await test.model.shutdown();
  });

  it.each(['response.failed', 'response.incomplete', 'response.cancelled', 'error'])(
    'fails on streamed terminal %s',
    async type => {
      let count = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        count++;
        return count === 1
          ? json({ id: 'response-1', status: 'completed', output: [] })
          : sse([{ type }]);
      });
      const test = setup(fetch);
      test.model.handle(test.effect, test.context);
      await waitForEvent(test.emitted, 'job.failed');
      expect(test.emitted.some(event => event.type === 'job.completed')).toBe(false);
      await test.model.shutdown();
    },
  );

  it('fails when the structure stream ends without a terminal', async () => {
    let count = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      count++;
      return count === 1
        ? json({ id: 'response-1', status: 'completed', output: [] })
        : sse([{ type: 'response.output_text.delta', delta: JSON.stringify(result) }]);
    });
    const test = setup(fetch);
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.failed');
    await test.model.shutdown();
  });

  it('charges exact search tokens plus issued queries and separate structure tokens', async () => {
    let count = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      count++;
      if (count > 1) return completedStream();
      return json({
        id: 'response-1',
        status: 'completed',
        output: [{ type: 'web_search_call', status: 'completed', action: { queries: ['one', 'two', 'three'] } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    });
    const test = setup(fetch);
    test.model.handle(test.effect, test.context);
    await waitForEvent(test.emitted, 'job.completed');
    const usage = test.emitted.filter(event => event.type === 'llm.usage');
    expect(usage).toHaveLength(2);
    expect(usage[0]?.payload).toMatchObject({ inputTokens: 100, outputTokens: 20, queries: 3, costUsd: 0.00771 });
    expect(usage[1]?.payload).toMatchObject({ inputTokens: 20, outputTokens: 10, queries: 0, costUsd: 0.0000675 });
    await test.model.shutdown();
  });
});
