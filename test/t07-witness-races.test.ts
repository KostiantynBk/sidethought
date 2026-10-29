import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { assembleContext } from '../src/context/index.js';
import type { Effect } from '../src/contract/index.js';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { parse, readyOutput } from './t03-helpers.js';
import { commit, fire, interpreted, replyResult } from './t07-helpers.js';

type CallEffect = Extract<Effect, { type: 'llm.call' }>;

function interpreterCall(effects: Effect[]): CallEffect {
  const call = effects.find(effect => effect.type === 'llm.call' && effect.role === 'interpreter');
  if (!call || call.type !== 'llm.call') throw new Error('missing interpreter dispatch');
  return call;
}

function quoteResult(state: State, inputId: string, quote: string, status: 'stated' | 'proposed' = 'stated') {
  const call = state.domain.call!;
  return reduce(state, parse({
    eventId: `quote-${state.meta.seq}`,
    sessionId: 's',
    acceptedAt: 5000,
    type: 'interpretation.ready',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: call.inputIds.map(id => ({ inputId: id, kind: 'statement' })),
        ops: [{
          op: 'create',
          kind: 'requirement',
          status,
          text: quote,
          quoteSpans: [{ inputId, start: 0, end: quote.length, quote }],
        }],
      },
    },
  }));
}

function recentIds(state: State, call: CallEffect): string[] {
  const input = JSON.parse(assembleContext(state, call).input);
  return input.recentWindow.map((turn: { id: string }) => turn.id);
}

it('retains a witnessed old user quote after later commits displace it from the live window', () => {
  const first = commit(initialState('s', loadConfig({ recentWindowTurns: 2 })), 0, 'first');
  const oldId = first.state.domain.inputs[0]!.id;
  const second = commit(interpreted(first.state).state, 1000, 'second');
  const call = interpreterCall(second.effects);
  expect(recentIds(second.state, call)).toEqual([oldId, second.state.domain.inputs[1]!.id]);
  const third = commit(second.state, 1100, 'third');
  expect(recentIds(third.state, call)).toEqual([oldId, second.state.domain.inputs[1]!.id]);
  const result = quoteResult(third.state, oldId, 'Use local storage.');
  expect(result.decisions.map(decision => decision.reason)).toContain('interpreter:ready');
  expect(Object.values(result.state.domain.items)[0]?.status).toBe('stated');
});

it('rejects assistant text acknowledged after interpreter dispatch and absent from its prompt', () => {
  const initial = commit(initialState('s', loadConfig()));
  const call = interpreterCall(initial.effects);
  const waiting = fire(initial.state, 'replyDebounce').state;
  const streaming = fire(waiting, 'interpreterSoftWait').state;
  const sent = replyResult(streaming, 'reply.chunk', 'Consider encrypted storage. ').state;
  const deliveryId = sent.domain.reply!.deliveryId;
  const acknowledged = reduce(sent, parse({
    eventId: 'rendered-after-dispatch',
    sessionId: 's',
    acceptedAt: 1600,
    type: 'delivery.progress',
    payload: {
      deliveryId,
      chunkIdx: 0,
      chars: 'Consider encrypted storage. '.length,
      final: false,
      reason: 'rendered',
    },
  })).state;
  expect(recentIds(acknowledged, call)).not.toContain(deliveryId);
  const result = quoteResult(acknowledged, deliveryId, 'Consider encrypted storage.', 'proposed');
  expect(result.decisions.map(decision => decision.reason)).toContain('span:mismatch');
  expect(result.state.domain.items).toEqual({});
  expect(result.state.domain.call?.attempt).toBe(2);
});

it('refreshes the retry witness and prompt at the retry dispatch', () => {
  const first = commit(initialState('s', loadConfig({ recentWindowTurns: 2 })), 0, 'first');
  const oldCall = interpreterCall(first.effects);
  const second = commit(first.state, 1000, 'second');
  const laterId = second.state.domain.inputs[1]!.id;
  expect(recentIds(second.state, oldCall)).not.toContain(laterId);
  const call = second.state.domain.call!;
  const retried = reduce(second.state, parse({
    eventId: 'first-failed',
    sessionId: 's',
    acceptedAt: 1100,
    type: 'interpretation.failed',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      reason: 'scripted failure',
    },
  }));
  const retryCall = interpreterCall(retried.effects);
  expect(retryCall.requestId).toBe(oldCall.requestId);
  expect(retryCall.callId).not.toBe(oldCall.callId);
  expect(recentIds(retried.state, retryCall)).toContain(laterId);
  const result = quoteResult(retried.state, laterId, 'Use local storage.');
  expect(result.decisions.map(decision => decision.reason)).toContain('interpreter:ready');
  expect(Object.values(result.state.domain.items)[0]?.status).toBe('stated');
});
