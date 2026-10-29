import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import type { RawEvent } from '../src/runtime/model-port.js';
import { DevModel } from '../src/runtime/dev-model.js';

const call = {
  type: 'llm.call' as const,
  role: 'responder' as const,
  requestId: 'request',
  callId: 'call',
  basisRev: 0,
  capturedInputs: [],
};

describe('dev model', () => {
  it('streams synthetic text and completes', async () => {
    vi.useFakeTimers();
    try {
      const model = new DevModel();
      const events: RawEvent[] = [];
      model.handle(call, { state: initialState('session', loadConfig()), emit: event => events.push(event) });
      await vi.runAllTimersAsync();
      expect(events.map(event => event.type)).toEqual([
        'reply.chunk', 'reply.chunk', 'reply.chunk', 'reply.chunk', 'reply.done',
      ]);
      await model.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops producing events after abort', async () => {
    vi.useFakeTimers();
    try {
      const model = new DevModel();
      const state = initialState('session', loadConfig());
      const events: RawEvent[] = [];
      const ctx = { state, emit: (event: RawEvent) => events.push(event) };
      model.handle(call, ctx);
      await vi.advanceTimersByTimeAsync(150);
      model.handle({ type: 'llm.abort', callId: 'call' }, ctx);
      await vi.runAllTimersAsync();
      expect(events.map(event => event.type)).toEqual(['reply.chunk']);
      await model.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('interprets every input as a statement without operations', () => {
    const model = new DevModel();
    const state = initialState('session', loadConfig());
    state.domain.call = {
      requestId: 'request',
      callId: 'call',
      attempt: 1,
      inputIds: ['one', 'two'],
      basisRev: 0,
      capturedInputs: [],
      quoteWitness: {
        recent: [],
        sources: [],
      },
    };
    const events: RawEvent[] = [];
    model.handle({ ...call, role: 'interpreter' }, { state, emit: event => events.push(event) });
    expect(events[0]?.payload).toMatchObject({
      output: { inputKinds: [{ inputId: 'one', kind: 'statement' }, { inputId: 'two', kind: 'statement' }], ops: [] },
    });
  });
});
