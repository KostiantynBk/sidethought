import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { invariantRegistry } from '../src/harness/index.js';
import { initialState, reduce } from '../src/kernel/index.js';
import { validateSpans, type QuoteInput } from '../src/kernel/items/index.js';
import { parse, readyOutput } from './t03-helpers.js';

const config = loadConfig();
function croppedCase(userText: string) {
  const initial = initialState('s', config);
  initial.domain.inputs.push({
    id: 'assistant',
    text: '€10',
    status: 'interpreted',
    origin: 'assistant',
  });
  const commit = parse({
    eventId: 'input',
    sessionId: 's',
    acceptedAt: 0,
    type: 'input.committed',
    payload: {
      clientMsgId: 'message',
      text: userText,
      modality: 'text',
    },
  });
  const state = reduce(initial, commit).state;
  const call = state.domain.call!;
  const quoteSpans = [
    {
      inputId: 'assistant',
      start: 0,
      end: 3,
      quote: '€10',
    },
    {
      inputId: state.domain.inputs[1]!.id,
      start: 0,
      end: 3,
      quote: '€10',
    },
  ];
  const event = parse({
    eventId: 'ready',
    sessionId: 's',
    acceptedAt: 1,
    type: 'interpretation.ready',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: state.domain.call!.inputIds.map(inputId => ({
          inputId,
          kind: 'statement',
        })),
        ops: [{
          op: 'create',
          kind: 'requirement',
          status: 'stated',
          text: '€10',
          quoteSpans,
        }],
      },
    },
  });
  return {
    state,
    event,
    quoteSpans,
    result: reduce(state, event),
  };
}

describe('numeric quote boundaries', () => {
  it('rejects a cropped €10 from user input €10.50 through the reducer', () => {
    const { result } = croppedCase('€10.50');
    expect(result.state.domain.items).toEqual({});
    expect(result.state.domain.inputs[1]?.status).toBe('interpreted');
    expect(result.decisions.map(decision => decision.reason)).toContain('span:partial_clause');
  });
  it('rejects a cropped €10 from user input €10.000 through the reducer', () => {
    const { result } = croppedCase('€10.000');
    expect(result.state.domain.items).toEqual({});
    expect(result.decisions.map(decision => decision.reason)).toContain('span:partial_clause');
  });
  it('accepts a full user clause containing €10.50', () => {
    const input: QuoteInput = {
      id: 'user',
      text: '€10.50',
      origin: 'user',
      modality: 'text',
    };
    const result = validateSpans({
      text: '€10.50',
      status: 'stated',
      quoteSpans: [{
        inputId: 'user',
        start: 0,
        end: input.text.length,
        quote: input.text,
      }],
    }, [input], config);
    expect(result.reason).toBe('span:valid');
    expect(result.status).toBe('stated');
  });
  it('rejects a span starting inside the fractional digits', () => {
    const input: QuoteInput = {
      id: 'user',
      text: '€10.50',
      origin: 'user',
      modality: 'text',
    };
    const result = validateSpans({
      text: '50',
      status: 'stated',
      quoteSpans: [{
        inputId: 'user',
        start: 4,
        end: 6,
        quote: '50',
      }],
    }, [input], config);
    expect(result.reason).toBe('span:partial_clause');
  });
  it('rejects a span ending before a numeric comma continuation', () => {
    const { result } = croppedCase('€10,000');
    expect(result.state.domain.items).toEqual({});
    expect(result.decisions.map(decision => decision.reason)).toContain('span:partial_clause');
  });
  it('I8 detects a forged stated item citing a cropped numeric span', () => {
    const { state, event, result, quoteSpans } = croppedCase('€10.50');
    const forged = structuredClone(result.state);
    forged.domain.items['s.2.1'] = {
      id: 's.2.1',
      kind: 'requirement',
      status: 'stated',
      text: '€10',
      contentVersion: 1,
      private: false,
      provenance: {
        origin: 'user',
        quoteSpans,
      },
      voiceConfirmNeeded: false,
    };
    forged.domain.projectRev++;
    const problems = invariantRegistry.flatMap(invariant =>
      invariant(state, event, forged, result.effects, result.decisions));
    expect(problems).toContain('I8 stated without valid user wording');
  });
});
