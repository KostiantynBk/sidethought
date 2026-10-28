import { expect, it } from 'vitest';
import { reduce } from '../src/kernel/index.js';
import { parse } from './t03-helpers.js';
import { edit, fixture, ready, reasons, start } from './t06-patch-helpers.js';

function request(inputId: string, ref: string) {
  return {
    inputId,
    question: 'Does local storage work?',
    publicQuery: 'local storage feasibility',
    depItemIds: [ref],
  };
}

function create(inputId: string, ref: string) {
  return {
    op: 'create',
    localRef: ref,
    kind: 'requirement',
    status: 'stated',
    text: 'Use local storage',
    quoteSpans: [{
      inputId,
      start: 0,
      end: 17,
      quote: 'Use local storage',
    }],
  };
}

it('starts the unrelated queued input after a second conflict, with exactly one interpreter call', () => {
  const first = edit(start(), 'edit-1', 1, 'Use encrypted cloud');
  const inputId = first.domain.inputs[0]!.id;
  const proposal = fixture('conflict-twice-needs-retry', inputId);
  const afterConflict = ready(first, proposal).state;
  const edited = edit(afterConflict, 'edit-2', 2, 'Use private cloud');
  const queued = reduce(edited, parse({
    eventId: 'later',
    sessionId: 's',
    acceptedAt: 11,
    type: 'input.committed',
    payload: {
      clientMsgId: 'later',
      text: 'Unrelated input.',
      modality: 'text',
    },
  })).state;
  const result = ready(queued, proposal, 'second-conflict');
  expect(reasons(result)).toContain('patch:conflict_needs_retry');
  expect(result.state.domain.inputs[0]?.status).toBe('needs_retry');
  expect(result.state.domain.inputs[1]?.status).toBe('inflight');
  expect(result.state.domain.call?.inputIds).toEqual([queued.domain.inputs[1]!.id]);
  expect(result.effects.filter(effect => effect.type === 'llm.call')).toHaveLength(1);
});

it('binds an accepted new:1 create to its actual ID at version 1', () => {
  const state = start();
  const inputId = state.domain.inputs[0]!.id;
  const result = ready(state, {
    ops: [create(inputId, 'new:1')],
    researchRequests: [request(inputId, 'new:1')],
  });
  const created = Object.values(result.state.domain.items).find(item => item.text === 'Use local storage')!;
  expect(created.contentVersion).toBe(1);
  expect(result.state.domain.pendingRequests[0]?.deps).toEqual([{
    itemId: created.id,
    contentVersion: 1,
  }]);
  expect(result.state.domain.pendingRequests[0]?.depItemIds).toEqual([created.id]);
});

it('binds an accepted inline replacement new:1 to its actual ID at version 1', () => {
  const state = start();
  const inputId = state.domain.inputs[0]!.id;
  const fresh = create(inputId, 'new:1');
  const { op: _op, ...replacement } = fresh;
  const result = ready(state, {
    ops: [{
      op: 'supersede',
      itemId: 'r1',
      quoteSpans: fresh.quoteSpans,
      replacement,
    }],
    researchRequests: [request(inputId, 'new:1')],
  });
  const created = Object.values(result.state.domain.items).find(item => item.text === 'Use local storage')!;
  expect(result.state.domain.items.r1?.status).toBe('superseded');
  expect(created.contentVersion).toBe(1);
  expect(result.state.domain.pendingRequests[0]?.deps).toEqual([{
    itemId: created.id,
    contentVersion: 1,
  }]);
  expect(result.state.domain.pendingRequests[0]?.depItemIds).toEqual([created.id]);
});

it('rejects __proto__ as an invalid localRef and retries without publishing a create or request', () => {
  const state = start();
  const inputId = state.domain.inputs[0]!.id;
  const call = state.domain.call!;
  const result = ready(state, {
    ops: [create(inputId, '__proto__')],
    researchRequests: [request(inputId, '__proto__')],
  });
  expect(result.state.domain.items).toEqual(state.domain.items);
  expect(result.state.domain.pendingRequests).toEqual([]);
  expect(result.state.domain.call?.requestId).toBe(call.requestId);
  expect(result.state.domain.call?.callId).not.toBe(call.callId);
  expect(result.state.domain.call?.attempt).toBe(2);
});

it('rejects __proto__ on an inline replacement without superseding the old item', () => {
  const state = start();
  const inputId = state.domain.inputs[0]!.id;
  const fresh = create(inputId, '__proto__');
  const { op: _op, ...replacement } = fresh;
  const call = state.domain.call!;
  const result = ready(state, {
    ops: [{
      op: 'supersede',
      itemId: 'r1',
      quoteSpans: fresh.quoteSpans,
      replacement,
    }],
    researchRequests: [request(inputId, '__proto__')],
  });
  expect(result.state.domain.items).toEqual(state.domain.items);
  expect(result.state.domain.pendingRequests).toEqual([]);
  expect(result.state.domain.call?.requestId).toBe(call.requestId);
  expect(result.state.domain.call?.callId).not.toBe(call.callId);
  expect(result.state.domain.call?.attempt).toBe(2);
});
