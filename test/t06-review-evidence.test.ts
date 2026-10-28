import { expect, it } from 'vitest';
import { fixture, ready, reasons, start } from './t06-patch-helpers.js';

type BadKind = 'create' | 'retract' | 'supersede-old' | 'supersede-replacement';

function validCreate(inputId: string) {
  return {
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
  };
}

function badOp(kind: BadKind, inputId: string) {
  const valid = validCreate(inputId);
  const span = valid.quoteSpans;
  if (kind === 'create') {
    return {
      ...valid,
      quoteSpans: [],
    };
  }
  if (kind === 'retract') {
    return {
      op: 'retract',
      itemId: 'r1',
      quoteSpans: [],
    };
  }
  return {
    op: 'supersede',
    itemId: 'r1',
    quoteSpans: kind === 'supersede-old' ? [] : span,
    replacement: {
      kind: 'requirement',
      status: 'stated',
      text: 'Use local storage',
      quoteSpans: kind === 'supersede-replacement' ? [] : span,
    },
  };
}

function output(kind: BadKind, grouped: boolean, inputId: string) {
  const good = validCreate(inputId);
  const bad = badOp(kind, inputId);
  return grouped
    ? {
      ops: [good],
      replacementGroups: [{
        ops: [bad, good],
      }],
    }
    : {
      ops: [good, bad],
    };
}

const cases: Array<[BadKind, boolean]> = [
  ['create', false],
  ['retract', false],
  ['supersede-old', false],
  ['supersede-replacement', false],
  ['create', true],
  ['retract', true],
  ['supersede-old', true],
  ['supersede-replacement', true],
];

it.each(cases)('rejects empty %s evidence (grouped=%s) as a whole-output mismatch twice', (kind, grouped) => {
  const state = start();
  const original = structuredClone(state.domain.items);
  const call = state.domain.call!;
  const inputId = state.domain.inputs[0]!.id;
  const proposal = {
    ...output(kind, grouped, inputId),
    clarification: 'Which option?',
    researchRequests: [{
      inputId,
      question: 'Is this feasible?',
      publicQuery: 'local storage feasibility',
      depItemIds: ['r1'],
    }],
  };
  const first = ready(state, proposal);
  expect(first.state.domain.items).toEqual(original);
  expect(first.state.domain.projectRev).toBe(state.domain.projectRev);
  expect(first.state.domain.pendingRequests).toEqual([]);
  expect(first.state.domain.clarifications).toEqual([]);
  expect(first.state.domain.call?.requestId).toBe(call.requestId);
  expect(first.state.domain.call?.callId).not.toBe(call.callId);
  expect(first.state.domain.call?.attempt).toBe(2);
  expect(reasons(first)).toContain('span:mismatch');
  const second = ready(first.state, proposal, 'second');
  expect(second.state.domain.items).toEqual(original);
  expect(second.state.domain.call).toBeNull();
  expect(second.state.domain.inputs[0]?.status).toBe('needs_retry');
  expect(reasons(second)).toContain('span:mismatch');
});

it('accepts an assistant-proposed create without spans', () => {
  const state = start();
  const result = ready(state, {
    ops: [{
      op: 'create',
      kind: 'option',
      status: 'proposed',
      text: 'Consider local backup',
      quoteSpans: [],
    }],
  });
  expect(Object.values(result.state.domain.items).find(item => item.text === 'Consider local backup')?.status)
    .toBe('proposed');
  expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
  expect(reasons(result)).not.toContain('span:mismatch');
});

it('retains the existing group-rejection fixture as non-mismatch coverage', () => {
  const state = start();
  const result = ready(state, fixture('group-atomic-reject', state.domain.inputs[0]!.id));
  expect(result.state.domain.items).toEqual(state.domain.items);
  expect(reasons(result)).toContain('patch:group_rejected');
});
