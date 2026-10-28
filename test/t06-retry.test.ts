import { expect, it } from 'vitest';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { config, parse, readyOutput } from './t03-helpers.js';

function commit(state: State, id: string, at: number): State {
  return reduce(state, parse({
    eventId: id,
    sessionId: 's',
    acceptedAt: at,
    type: 'input.committed',
    payload: {
      clientMsgId: id,
      text: 'Never use cloud.',
      modality: 'text',
    },
  })).state;
}

function retry(state: State, ids: string[], eventId = 'retry') {
  return reduce(state, parse({
    eventId,
    sessionId: 's',
    acceptedAt: 20,
    type: 'input.retry',
    payload: { inputIds: ids },
  }));
}

function complete(state: State, eventId: string, output: object = {}) {
  const call = state.domain.call!;
  return reduce(state, parse({
    eventId,
    sessionId: 's',
    acceptedAt: 10,
    type: 'interpretation.ready',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: call.inputIds.map(inputId => ({
          inputId,
          kind: 'statement',
        })),
        ...output,
      },
    },
  }));
}

function fail(state: State, eventId: string): State {
  const call = state.domain.call!;
  return reduce(state, parse({
    eventId,
    sessionId: 's',
    acceptedAt: 10,
    type: 'interpretation.failed',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      reason: 'test failure',
    },
  })).state;
}

function edit(state: State, id: string, version: number): State {
  return reduce(state, parse({
    eventId: id,
    sessionId: 's',
    acceptedAt: 5,
    type: 'item.action',
    payload: {
      itemId: 'r1',
      expectedVersion: version,
      action: 'edit',
      text: `Cloud revision ${version}`,
    },
  })).state;
}

function retract(inputId: string) {
  return {
    ops: [{
      op: 'retract',
      itemId: 'r1',
      quoteSpans: [{
        inputId,
        start: 0,
        end: 15,
        quote: 'Never use cloud',
      }],
    }],
  };
}

it('retries after two conflicts, resets their count, and successfully applies the output', () => {
  const initial = initialState('s', config);
  initial.domain.items.r1 = {
    id: 'r1',
    kind: 'requirement',
    status: 'stated',
    text: 'Use cloud',
    contentVersion: 1,
    private: false,
    provenance: {
      origin: 'user',
      quoteSpans: [],
    },
    voiceConfirmNeeded: false,
  };
  const started = commit(initial, 'm1', 0);
  const inputId = started.domain.inputs[0]!.id;
  const first = complete(edit(started, 'edit1', 1), 'ready1', retract(inputId));
  const second = complete(edit(first.state, 'edit2', 2), 'ready2', retract(inputId));
  expect(second.state.domain.inputs[0]?.status).toBe('needs_retry');
  expect(second.state.domain.inputs[0]?.conflicts).toBe(2);
  const resumed = retry(second.state, [inputId]);
  expect(resumed.state.domain.inputs[0]?.conflicts).toBe(0);
  expect(resumed.state.domain.call?.inputIds).toEqual([inputId]);
  expect(resumed.state.domain.call?.capturedInputs).toContainEqual({
    itemId: 'r1',
    contentVersion: 3,
  });
  const result = complete(resumed.state, 'ready3', retract(inputId));
  expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
  expect(result.state.domain.items.r1?.status).toBe('retracted');
});

it('does not retry an interpreted input and records retry:not_needed', () => {
  const initial = commit(initialState('s', config), 'm1', 0);
  const done = complete(initial, 'ready1').state;
  const result = retry(done, [done.domain.inputs[0]!.id]);
  expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
  expect(result.state.domain.call).toBeNull();
  expect(result.decisions.map(decision => decision.reason)).toContain('retry:not_needed');
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
});

it('ignores unknown IDs and records retry:unknown_input', () => {
  const state = initialState('s', config);
  const result = retry(state, ['missing']);
  expect(result.state.domain.inputs).toEqual([]);
  expect(result.state.domain.call).toBeNull();
  expect(result.decisions.map(decision => decision.reason)).toContain('retry:unknown_input');
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
});

it('allows explicit retry after both interpreter attempts fail', () => {
  const started = commit(initialState('s', config), 'm1', 0);
  const failed = fail(fail(started, 'failed1'), 'failed2');
  expect(failed.domain.inputs[0]?.status).toBe('needs_retry');
  const inputId = failed.domain.inputs[0]!.id;
  const resumed = retry(failed, [inputId]);
  expect(resumed.state.domain.call?.inputIds).toEqual([inputId]);
  expect(resumed.state.domain.call?.attempt).toBe(1);
  const result = complete(resumed.state, 'ready1');
  expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
});

it('does not restart work on recovery but permits a later explicit retry', () => {
  const started = commit(initialState('s', config), 'm1', 0);
  const recovered = reduce(started, parse({
    eventId: 'recovery',
    sessionId: 's',
    acceptedAt: 10,
    type: 'session.recovered',
    payload: {},
  }));
  expect(recovered.state.domain.inputs[0]?.status).toBe('needs_retry');
  expect(recovered.state.domain.call).toBeNull();
  expect(recovered.effects.some(effect => effect.type === 'llm.call')).toBe(false);
  const inputId = recovered.state.domain.inputs[0]!.id;
  const resumed = retry(recovered.state, [inputId]);
  expect(resumed.state.domain.call?.inputIds).toEqual([inputId]);
  expect(complete(resumed.state, 'ready1').state.domain.inputs[0]?.status).toBe('interpreted');
});

it('queues a retry behind an existing interpreter call without dispatching a second call', () => {
  const started = commit(initialState('s', config), 'm1', 0);
  const failed = fail(fail(started, 'failed1'), 'failed2');
  const oldInput = failed.domain.inputs[0]!.id;
  const busy = commit(failed, 'm2', 11);
  const activeCall = busy.domain.call!;
  const resumed = retry(busy, [oldInput]);
  expect(resumed.state.domain.call?.callId).toBe(activeCall.callId);
  expect(resumed.state.domain.inputs[0]?.status).toBe('waiting');
  expect(resumed.effects.some(effect => effect.type === 'llm.call')).toBe(false);
  const completed = complete(resumed.state, 'ready-active');
  expect(completed.state.domain.inputs[1]?.status).toBe('interpreted');
  expect(completed.state.domain.call?.inputIds).toEqual([oldInput]);
  expect(completed.state.domain.call?.callId).not.toBe(activeCall.callId);
  expect(completed.effects.filter(effect => effect.type === 'llm.call')).toHaveLength(1);
  expect(complete(completed.state, 'ready-retry').state.domain.inputs[0]?.status).toBe('interpreted');
});
