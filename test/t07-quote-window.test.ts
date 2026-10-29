import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { allowedQuoteInputs } from '../src/context/quote-sources.js';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { parse, readyOutput } from './t03-helpers.js';
import { commit, interpreted } from './t07-helpers.js';

function cite(state: State, inputId: string) {
  const call = state.domain.call!;
  return reduce(state, parse({
    eventId: `cite-${state.meta.seq}`,
    sessionId: 's',
    acceptedAt: 2000,
    type: 'interpretation.ready',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: call.inputIds.map(id => ({
          inputId: id,
          kind: 'statement',
        })),
        ops: [{
          op: 'create',
          kind: 'requirement',
          status: 'stated',
          text: 'Use local storage.',
          quoteSpans: [{
            inputId,
            start: 0,
            end: 18,
            quote: 'Use local storage.',
          }],
        }],
      },
    },
  }));
}

it('rejects a previously interpreted quote outside the finite recent window', () => {
  const first = commit(initialState('s', loadConfig({ recentWindowTurns: 1 }))).state;
  const oldId = first.domain.inputs[0]!.id;
  const second = commit(interpreted(first).state, 1000, 'second').state;
  const result = cite(second, oldId);
  expect(result.decisions.map(decision => decision.reason)).toContain('span:mismatch');
  expect(result.state.domain.items).toEqual({});
  expect(result.state.domain.call?.attempt).toBe(2);
});

it('accepts a previously interpreted quote inside the finite recent window', () => {
  const first = commit(initialState('s', loadConfig({ recentWindowTurns: 2 }))).state;
  const oldId = first.domain.inputs[0]!.id;
  const second = commit(interpreted(first).state, 1000, 'second').state;
  const result = cite(second, oldId);
  expect(result.decisions[0]?.reason).toBe('interpreter:ready');
  expect(Object.values(result.state.domain.items)[0]?.status).toBe('stated');
});

it('excludes a later uninterpreted input from a running interpreter batch', () => {
  const first = commit(initialState('s', loadConfig())).state;
  const second = commit(first, 1000, 'second').state;
  const batch = second.domain.call!.inputIds;
  expect(allowedQuoteInputs(second.domain, batch, 1).map(input => input.id)).toEqual(batch);
});

it('keeps a current batch input eligible even after newer messages displace it from the window', () => {
  const first = commit(initialState('s', loadConfig({ recentWindowTurns: 1 }))).state;
  const batchId = first.domain.inputs[0]!.id;
  const second = commit(first, 1000, 'second').state;
  const result = cite(second, batchId);
  expect(result.decisions[0]?.reason).toBe('interpreter:ready');
  expect(Object.values(result.state.domain.items)[0]?.status).toBe('stated');
});
