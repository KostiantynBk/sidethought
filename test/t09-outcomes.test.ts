import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterpreterOutputSchema } from '../src/contract/roles.js';
import { delta, finished, run, setup, terminal, usage, validOutput } from './t09-helpers.js';

beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('network prohibited'); }));
afterEach(() => vi.unstubAllGlobals());

describe('Meta terminal outcomes', () => {
  it('emits ordered reply chunks then completion and accurately meters cached input and reasoning', async () => {
    const { emitted, model } = await run('responder', [delta('Hello '), delta('there.'), terminal()]);
    expect(emitted.map(event => event.eventId)).toEqual(['call:chunk:0', 'call:chunk:1', 'call:usage', 'call:done']);
    expect(emitted.map(event => event.type)).toEqual(['reply.chunk', 'reply.chunk', 'llm.usage', 'reply.done']);
    expect(emitted[0]?.payload).toEqual({ requestId: 'request', callId: 'call', text: 'Hello ' });
    expect(emitted[2]?.payload).toEqual({
      callId: 'call',
      inputTokens: 1000,
      outputTokens: 200,
      queries: 0,
      audioSeconds: 0,
      costUsd: 0.00166,
    });
    expect(model.metrics.get('call')?.usage).toMatchObject({ cachedInputTokens: 400, reasoningTokens: 150 });
    expect(emitted.every(event => event.sessionId === 'session')).toBe(true);
  });

  it('fails on response.failed after preserving previously emitted deltas', async () => {
    const { emitted } = await run('responder', [delta('Partial.'), terminal('response.failed')]);
    expect(emitted.map(event => event.type)).toEqual(['reply.chunk', 'llm.usage', 'reply.failed']);
  });

  it('fails on non-cap response.incomplete', async () => {
    const { emitted } = await run('responder', [terminal('response.incomplete', 'content_filter')]);
    expect(emitted.at(-1)?.type).toBe('reply.failed');
  });

  it('completes a capped Responder so the kernel can check and flush its tail', async () => {
    const { emitted, model } = await run('responder', [delta('A tail'),
      terminal('response.incomplete', 'max_output_tokens')]);
    expect(emitted.at(-1)?.type).toBe('reply.done');
    expect(model.metrics.get('call')?.outcome).toBe('cap_reached');
    expect(model.metrics.get('call')?.terminalType).toBe('response.incomplete');
  });

  it('fails on an error SSE event and preserves usage outside its nested error', async () => {
    const { emitted } = await run('responder', [{
      type: 'error',
      error: { code: 'server_error', message: 'synthetic diagnostic must not be forwarded' },
      usage,
    }]);
    expect(emitted.map(event => event.type)).toEqual(['llm.usage', 'reply.failed']);
    expect(JSON.stringify(emitted)).not.toContain('synthetic diagnostic');
  });

  it('fails when HTTP 200 ends without a terminal event', async () => {
    const { emitted } = await run('responder', [delta('Partial')]);
    expect(emitted.at(-1)?.payload).toMatchObject({ reason: 'missing_terminal' });
  });

  it('validates accumulated Interpreter JSON before emitting readiness', async () => {
    const json = JSON.stringify(validOutput);
    const { emitted, model } = await run('interpreter', [delta(json.slice(0, 20)), delta(json.slice(20)), terminal()]);
    expect(emitted.map(event => event.type)).toEqual(['llm.usage', 'interpretation.ready']);
    const payload = emitted.at(-1)?.payload as { output: unknown };
    expect(InterpreterOutputSchema.safeParse(payload.output).success).toBe(true);
    expect(model.metrics.get('call')?.schemaValid).toBe(true);
  });

  it('fails malformed JSON without making an adapter repair call', async () => {
    const { emitted, fetch } = await run('interpreter', [delta('{broken'), terminal()]);
    expect(emitted.at(-1)?.payload).toMatchObject({ reason: 'invalid_json' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails schema-invalid JSON without making an adapter repair call', async () => {
    const { emitted, fetch } = await run('interpreter', [delta('{}'), terminal()]);
    expect(emitted.at(-1)?.payload).toMatchObject({ reason: 'invalid_schema' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects capped Interpreter output even when the accumulated JSON is otherwise valid', async () => {
    const { emitted, fetch } = await run('interpreter', [delta(JSON.stringify(validOutput)),
      terminal('response.incomplete', 'max_output_tokens')]);
    expect(emitted.at(-1)?.type).toBe('interpretation.failed');
    expect(emitted.at(-1)?.payload).toMatchObject({ reason: 'output_cap' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a terminal Interpreter failure even when valid JSON was streamed', async () => {
    const { emitted } = await run('interpreter', [delta(JSON.stringify(validOutput)), terminal('response.failed')]);
    expect(emitted.at(-1)?.type).toBe('interpretation.failed');
  });

  it('ignores metadata events rather than mistaking them for outcomes', async () => {
    const { emitted } = await run('responder', [{ type: 'response.created' }, { type: 'response.output_text.done' }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({ reason: 'missing_terminal' });
  });

  it('stops after the first terminal event without duplicate usage or completion', async () => {
    const { emitted } = await run('responder', [terminal(), terminal(), delta('late')]);
    expect(emitted.map(event => event.eventId)).toEqual(['call:usage', 'call:done']);
  });

  it('reproduces event IDs when the same call is replayed through a fresh executor', async () => {
    const first = await run('responder', [delta('Hello.'), terminal()]);
    const second = await run('responder', [delta('Hello.'), terminal()]);
    expect(first.emitted).toEqual(second.emitted);
  });

  it('keeps the cap metric when a kernel check aborts synchronously on reply.done', async () => {
    const test = setup('responder', [delta('A tail'), terminal('response.incomplete', 'max_output_tokens')]);
    const ctx = {
      state: test.ctx.state,
      emit: (event: Parameters<typeof test.ctx.emit>[0]) => {
        test.ctx.emit(event);
        if (event.type === 'reply.done') test.model.handle({ type: 'llm.abort', callId: 'call' }, test.ctx);
      },
    };
    test.model.handle(test.effect, ctx);
    await finished(test.model);
    expect(test.model.metrics.get('call')).toMatchObject({ outcome: 'cap_reached', locallyAborted: true });
    await test.model.shutdown();
  });

  it('deduplicates repeated call effects within one executor', async () => {
    const test = setup('responder', [delta('Hello.'), terminal()]);
    test.model.handle(test.effect, test.ctx);
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    test.model.handle(test.effect, test.ctx);
    expect(test.fetch).toHaveBeenCalledTimes(1);
    await test.model.shutdown();
  });
});
