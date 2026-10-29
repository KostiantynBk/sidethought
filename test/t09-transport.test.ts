import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delta, finished, sentinel, setupFetch, sse, terminal, wire } from './t09-helpers.js';

beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('network prohibited'); }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
  });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  return {
    fetch,
    send: (event: Record<string, unknown>) => controller.enqueue(encoder.encode(wire(event))),
    error: () => controller.error(new Error(`synthetic transport detail ${sentinel}`)),
  };
}

describe('Meta transport and cancellation', () => {
  it('aborts the HTTP signal mid-stream and emits nothing after the abort', async () => {
    const stream = controlledStream();
    const test = setupFetch('responder', stream.fetch);
    test.model.handle(test.effect, test.ctx);
    stream.send(delta('First.'));
    await vi.waitFor(() => expect(test.emitted).toHaveLength(1));
    // Queue a terminal immediately before abort, without giving its read a microtask turn.
    stream.send(terminal());
    test.model.handle({ type: 'llm.abort', callId: 'call' }, test.ctx);
    const atAbort = [...test.emitted];
    await test.model.shutdown();
    expect(stream.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(test.emitted).toEqual(atAbort);
    expect(test.model.metrics.get('call')?.outcome).toBe('aborted');
  });

  it('treats an unknown or finished abort as a no-op', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sse([terminal()]));
    const test = setupFetch('responder', fetch);
    test.model.handle({ type: 'llm.abort', callId: 'unknown' }, test.ctx);
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    const before = [...test.emitted];
    test.model.handle({ type: 'llm.abort', callId: 'call' }, test.ctx);
    expect(test.emitted).toEqual(before);
    expect(test.model.metrics.get('call')?.outcome).toBe('completed');
    await test.model.shutdown();
  });

  it('aborts all pending work on shutdown and refuses subsequent calls', async () => {
    const stream = controlledStream();
    const test = setupFetch('responder', stream.fetch);
    test.model.handle(test.effect, test.ctx);
    await vi.waitFor(() => expect(stream.fetch).toHaveBeenCalledTimes(1));
    await test.model.shutdown();
    test.model.handle({ ...test.effect, callId: 'later' }, test.ctx);
    expect(test.emitted).toEqual([]);
    expect(stream.fetch).toHaveBeenCalledTimes(1);
    expect(stream.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('fails a mid-stream transport error without leaking its content', async () => {
    const stream = controlledStream();
    const test = setupFetch('responder', stream.fetch);
    test.model.handle(test.effect, test.ctx);
    stream.send(delta('First.'));
    await vi.waitFor(() => expect(test.emitted).toHaveLength(1));
    stream.error();
    await finished(test.model);
    expect(test.emitted.at(-1)?.type).toBe('reply.failed');
    expect(JSON.stringify(test.emitted)).not.toContain(sentinel);
    await test.model.shutdown();
  });

  it('does not retry HTTP 429 and never exposes SDK diagnostics containing the key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      error: { message: sentinel, code: 'rate_limit' },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const onMetric = vi.fn();
    const test = setupFetch('responder', fetch, { onMetric });
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(test.emitted.at(-1)?.payload).toMatchObject({ reason: 'model_error' });
    expect(JSON.stringify([test.emitted, onMetric.mock.calls, log.mock.calls, warn.mock.calls, error.mock.calls]))
      .not.toContain(sentinel);
    await expect(test.model.shutdown()).resolves.toBeUndefined();
  });

  it('fails a non-SSE HTTP 200 instead of reporting success', async () => {
    const test = setupFetch('responder', async () => new Response('{"status":"completed"}', {
      headers: { 'content-type': 'application/json' },
    }));
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    expect(test.emitted.at(-1)?.type).toBe('reply.failed');
    await test.model.shutdown();
  });

  it('decodes fragmented UTF-8, CRLF and multi-line data fields', async () => {
    const text = 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\n'
      + 'data: "delta":"café"}\r\n\r\n' + wire(terminal());
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const test = setupFetch('responder', async () => new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    expect(test.emitted[0]?.payload).toMatchObject({ text: 'café' });
    expect(test.emitted.at(-1)?.type).toBe('reply.done');
    await test.model.shutdown();
  });

  it('sanitizes malformed SSE JSON without logging its text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const test = setupFetch('responder', async () => new Response(`data: ${sentinel}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    expect(test.emitted.at(-1)?.type).toBe('reply.failed');
    expect(JSON.stringify([test.emitted, error.mock.calls])).not.toContain(sentinel);
    await test.model.shutdown();
  });

  it('treats an assembly exception as a value-free failure without making an HTTP call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const test = setupFetch('responder', fetch, {
      assemble: () => { throw new Error(sentinel); },
    });
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    expect(fetch).not.toHaveBeenCalled();
    expect(test.emitted.at(-1)?.payload).toMatchObject({ reason: 'model_error' });
    await test.model.shutdown();
  });

  it('records first-delta and terminal timing without prompt or model text', async () => {
    const stream = controlledStream();
    let time = 10;
    const test = setupFetch('responder', stream.fetch, { now: () => time });
    test.model.handle(test.effect, test.ctx);
    await vi.waitFor(() => expect(stream.fetch).toHaveBeenCalledTimes(1));
    time = 25;
    stream.send(delta('Synthetic private answer.'));
    await vi.waitFor(() => expect(test.emitted).toHaveLength(1));
    time = 40;
    stream.send(terminal());
    await finished(test.model);
    const metric = test.model.metrics.get('call');
    expect(metric).toMatchObject({ firstDeltaMs: 15, terminalMs: 30, providerResponseId: 'response-synthetic' });
    expect(JSON.stringify(metric)).not.toContain('Synthetic private answer');
    expect(JSON.stringify(metric)).not.toContain('synthetic instructions');
    await test.model.shutdown();
  });
});
