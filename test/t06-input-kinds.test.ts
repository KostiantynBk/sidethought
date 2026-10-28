import { expect, it } from 'vitest';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { config, parse, readyOutput } from './t03-helpers.js';

type Kind = 'statement' | 'wait';
type InputKind = {
  inputId: string;
  kind: Kind;
};

function commit(state: State, id: string, text: string, at: number): State {
  return reduce(state, parse({
    eventId: id,
    sessionId: 's',
    acceptedAt: at,
    type: 'input.committed',
    payload: {
      clientMsgId: id,
      text,
      modality: 'text',
    },
  })).state;
}

function ready(state: State, kinds: InputKind[], id: string, withCreate = false) {
  const call = state.domain.call!;
  const inputId = call.inputIds[0]!;
  return reduce(state, parse({
    eventId: id,
    sessionId: 's',
    acceptedAt: 10,
    type: 'interpretation.ready',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: kinds,
        ops: withCreate ? [{
          op: 'create',
          kind: 'requirement',
          status: 'stated',
          text: 'Use local storage',
          quoteSpans: [{
            inputId,
            start: 0,
            end: 17,
            quote: 'Use local storage',
          }],
        }] : [],
      },
    },
  }));
}

function started(): State {
  return commit(initialState('s', config), 'm1', 'Use local storage.', 0);
}

function expectRetry(state: State, kinds: InputKind[]): State {
  const oldCall = state.domain.call!;
  const result = ready(state, kinds, 'invalid', true);
  expect(result.state.domain.items).toEqual(state.domain.items);
  expect(result.state.domain.projectRev).toBe(state.domain.projectRev);
  expect(result.state.domain.call?.requestId).toBe(oldCall.requestId);
  expect(result.state.domain.call?.callId).not.toBe(oldCall.callId);
  expect(result.state.domain.call?.attempt).toBe(2);
  expect(result.state.domain.inputs[0]?.status).toBe('inflight');
  expect(result.decisions.map(decision => decision.reason)).toContain('interpreter:retry');
  return result.state;
}

it('retries without mutation when a batch input kind is missing', () => {
  expectRetry(started(), []);
});

it('retries without mutation when an input kind appears twice', () => {
  const state = started();
  const inputId = state.domain.inputs[0]!.id;
  expectRetry(state, [
    {
      inputId,
      kind: 'statement',
    },
    {
      inputId,
      kind: 'wait',
    },
  ]);
});

it('retries without mutation when the kind names a foreign input', () => {
  expectRetry(started(), [{
    inputId: 'foreign',
    kind: 'statement',
  }]);
});

it('marks the input needs_retry after two invalid kind outputs', () => {
  const first = expectRetry(started(), []);
  const second = ready(first, [], 'invalid-again', true);
  expect(second.state.domain.items).toEqual({});
  expect(second.state.domain.call).toBeNull();
  expect(second.state.domain.inputs[0]?.status).toBe('needs_retry');
  expect(second.decisions.map(decision => decision.reason)).toContain('interpreter:needs_retry');
});

it('records a mixed statement then wait batch and activates wait for the newest input', () => {
  const first = started();
  const withStatement = commit(first, 'm2', 'Continue.', 1);
  const queued = commit(withStatement, 'm3', 'Please wait.', 2);
  const previous = ready(queued, [{
    inputId: queued.domain.inputs[0]!.id,
    kind: 'statement',
  }], 'first-ready');
  const batch = previous.state;
  const secondId = batch.domain.inputs[1]!.id;
  const thirdId = batch.domain.inputs[2]!.id;
  expect(batch.domain.call?.inputIds).toEqual([secondId, thirdId]);
  // Reverse the model's array order: recency must follow the input order, not output order.
  const result = ready(batch, [
    {
      inputId: thirdId,
      kind: 'wait',
    },
    {
      inputId: secondId,
      kind: 'statement',
    },
  ], 'batch-ready');
  expect(result.state.domain.inputs.map(input => input.kind)).toEqual(['statement', 'statement', 'wait']);
  expect(result.state.domain.inputs.every(input => input.status === 'interpreted')).toBe(true);
  expect(result.state.domain.userWait).toBe(true);
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'timer.set',
      purpose: 'userWait',
    }));
});
