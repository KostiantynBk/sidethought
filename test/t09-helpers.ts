import { expect, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { MetaModel, type MetaOptions } from '../src/model/meta/executor.js';
import type { CallEffect } from '../src/context/index.js';
import type { RawEvent } from '../src/runtime/model-port.js';

export const sentinel = 'synthetic-key-for-hygiene-tests-only';
export const validOutput = {
  inputKinds: [{ inputId: 'input', kind: 'statement' }],
  ops: [],
  replacementGroups: [],
  researchRequests: [],
  deprioritizedTopics: [],
  voiceConfirmValues: [],
};
export const usage = {
  input_tokens: 1000,
  output_tokens: 200,
  input_tokens_details: { cached_tokens: 400 },
  output_tokens_details: { reasoning_tokens: 150 },
};
export const delta = (text: string) => ({ type: 'response.output_text.delta', delta: text });
export const terminal = (type = 'response.completed', reason?: string) => ({
  type,
  response: {
    id: 'response-synthetic',
    usage,
    ...(reason ? { incomplete_details: { reason } } : {}),
  },
});
export function wire(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
export function sse(events: Record<string, unknown>[]): Response {
  return new Response(events.map(wire).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}
export function setup(role: 'interpreter' | 'responder', events: Record<string, unknown>[], options: MetaOptions = {}) {
  const requests: RequestInit[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    requests.push(init!);
    return sse(events);
  });
  return setupFetch(role, fetch, options, requests);
}
export function setupFetch(
  role: 'interpreter' | 'responder',
  fetch: typeof globalThis.fetch,
  options: MetaOptions = {},
  requests: RequestInit[] = [],
) {
  const state = initialState('session', loadConfig());
  const effect: CallEffect = {
    type: 'llm.call',
    role,
    requestId: 'request',
    callId: 'call',
    basisRev: 0,
    capturedInputs: [],
  };
  state.domain.call = {
    requestId: effect.requestId,
    callId: effect.callId,
    attempt: 1,
    basisRev: 0,
    capturedInputs: [],
    inputIds: ['input'],
    quoteWitness: { recent: [], sources: [] },
  };
  const meta = modelConfiguration({ MODEL_API_KEY: sentinel }).meta!;
  const model = new MetaModel(meta.createClient(fetch), meta.prices, {
    assemble: () => ({ instructions: 'synthetic instructions', input: 'synthetic input' }),
    ...options,
  });
  const emitted: RawEvent[] = [];
  const ctx = { state, emit: (event: RawEvent) => { emitted.push(event); } };
  return { model, effect, ctx, emitted, fetch, requests };
}
export async function finished(model: MetaModel, callId = 'call'): Promise<void> {
  await vi.waitFor(() => expect(model.metrics.get(callId)?.terminalMs).toBeTypeOf('number'));
}
export async function run(role: 'interpreter' | 'responder', events: Record<string, unknown>[]) {
  const test = setup(role, events);
  test.model.handle(test.effect, test.ctx);
  await finished(test.model);
  await test.model.shutdown();
  return test;
}
