import { describe, expect, it } from 'vitest';
import type { Item } from '../src/contract/index.js';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { commit, config, parse, readyOutput } from './t03-helpers.js';

const proposal: Item = {
  id: 'p',
  kind: 'option',
  status: 'proposed',
  text: 'Encrypted export',
  contentVersion: 1,
  private: false,
  provenance: {
    origin: 'assistant',
    quoteSpans: [],
  },
  voiceConfirmNeeded: false,
};

function dispatched(withProposal = true): State {
  const state = initialState('s', config);
  if (withProposal) state.domain.items.p = { ...proposal };
  return reduce(state, commit('commit', 'm', 0)).state;
}

function ready(state: State, output: object, eventId = 'ready') {
  const call = state.domain.call!;
  return reduce(
    state,
    parse({
      eventId,
      sessionId: 's',
      acceptedAt: 10,
      type: 'interpretation.ready',
      payload: {
        requestId: call.requestId,
        callId: call.callId,
        output: {
          ...output,
          inputKinds: call.inputIds.map(inputId => ({
            inputId,
            kind: 'statement',
          })),
        },
      },
    }),
  );
}

function malformed(state: State) {
  return {
    ...readyOutput,
    ops: [
      {
        op: 'create',
        kind: 'requirement',
        status: 'stated',
        text: 'x',
        quoteSpans: [
          {
            inputId: state.domain.inputs[0]!.id,
            start: 0,
            end: 1,
            quote: 'z',
          },
        ],
      },
    ],
    agreesWith: ['p'],
  };
}

describe('interpreter T05 hook', () => {
  it('flags a captured proposed item without changing its status', () => {
    const state = dispatched();
    const result = ready(state, {
      ...readyOutput,
      agreesWith: ['p'],
    });
    expect(result.state.domain.items.p?.status).toBe('proposed');
    expect(result.state.domain.items.p?.verbalConfirmPending).toBe(true);
    expect(result.decisions.map((decision) => decision.reason)).toContain('item:verbal_confirm_pending');
  });
  it('flags an assistant proposal created from a voice input without quote spans', () => {
    const event = parse({
      eventId: 'voice',
      sessionId: 's',
      acceptedAt: 0,
      type: 'input.committed',
      payload: {
        clientMsgId: 'voice-message',
        text: 'hello',
        modality: 'voice',
      },
    });
    const state = reduce(initialState('s', config), event).state;
    const result = ready(state, {
      ...readyOutput,
      ops: [{
        op: 'create',
        kind: 'option',
        status: 'proposed',
        text: 'local notes',
        quoteSpans: [],
      }],
    });
    expect(result.state.domain.items['s.2.1']?.voiceConfirmNeeded).toBe(true);
  });
  it('drops an agreement targeting an item absent from the captured snapshot', () => {
    const state = dispatched(false);
    state.domain.items.p = { ...proposal };
    const result = ready(state, {
      ...readyOutput,
      agreesWith: ['p'],
    });
    expect(result.state.domain.items.p?.verbalConfirmPending).toBeUndefined();
    expect(result.decisions.map((decision) => decision.reason)).toContain('agree:invalid_target');
  });
  it('drops an agreement if the captured item is no longer proposed', () => {
    const state = dispatched();
    state.domain.items.p = {
      ...proposal,
      status: 'rejected',
    };
    const result = ready(state, {
      ...readyOutput,
      agreesWith: ['p'],
    });
    expect(result.state.domain.items.p?.verbalConfirmPending).toBeUndefined();
    expect(result.decisions.map((decision) => decision.reason)).toContain('agree:invalid_target');
  });
  it('retries a mismatch without applying agreements and uses a fresh call ID', () => {
    const state = dispatched();
    const oldId = state.domain.call!.callId;
    const result = ready(state, malformed(state));
    expect(result.state.domain.items.p?.verbalConfirmPending).toBeUndefined();
    expect(result.state.domain.call?.callId).not.toBe(oldId);
    expect(result.state.domain.call?.attempt).toBe(2);
    expect(result.decisions.map((decision) => decision.reason)).toContain('span:mismatch');
  });
  it('rejects a span into a later input outside the interpreter batch', () => {
    const initial = dispatched(false);
    const queued = reduce(initial, commit('later', 'later-message', 1)).state;
    const later = queued.domain.inputs[1]!;
    const output = {
      ...readyOutput,
      ops: [
        {
          op: 'create',
          kind: 'requirement',
          status: 'stated',
          text: 'x',
          quoteSpans: [
            {
              inputId: later.id,
              start: 0,
              end: 1,
              quote: 'x',
            },
          ],
        },
      ],
    };
    const result = ready(queued, output);
    expect(result.state.domain.items).toEqual({});
    expect(result.state.domain.call?.attempt).toBe(2);
    expect(result.decisions.map((decision) => decision.reason)).toContain('span:mismatch');
  });
  it('drops a partial-clause op while marking the input interpreted', () => {
    const initial = initialState('s', config);
    const inputEvent = parse({
      eventId: 'partial-input',
      sessionId: 's',
      acceptedAt: 0,
      type: 'input.committed',
      payload: {
        clientMsgId: 'partial-message',
        text: 'Notes stay local.',
        modality: 'text',
      },
    });
    const state = reduce(initial, inputEvent).state;
    const output = {
      ...readyOutput,
      ops: [
        {
          op: 'create',
          kind: 'requirement',
          status: 'stated',
          text: 'Notes',
          quoteSpans: [
            {
              inputId: state.domain.inputs[0]!.id,
              start: 0,
              end: 5,
              quote: 'Notes',
            },
          ],
        },
      ],
    };
    const result = ready(state, output);
    expect(result.state.domain.call).toBeNull();
    expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
    expect(result.state.domain.items).toEqual({});
    expect(result.decisions.map((decision) => decision.reason)).toContain('span:partial_clause');
  });
  it('marks the input needs_retry after two mismatched outputs', () => {
    const state = dispatched();
    const first = ready(state, malformed(state));
    const second = ready(first.state, malformed(first.state), 'second');
    expect(second.state.domain.call).toBeNull();
    expect(second.state.domain.inputs[0]?.status).toBe('needs_retry');
    expect(second.state.domain.items.p?.verbalConfirmPending).toBeUndefined();
  });
});
