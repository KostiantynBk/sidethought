import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { invariantRegistry } from '../src/harness/index.js';
import { initialState, reduce } from '../src/kernel/index.js';
import { validateSpans, type QuoteInput } from '../src/kernel/items/index.js';
import { extractAmounts } from '../src/kernel/items/amounts.js';
import { parse, readyOutput } from './t03-helpers.js';

const config = loadConfig();
function source(id: string, text: string, origin: QuoteInput['origin']): QuoteInput {
  return {
    id,
    text,
    origin,
    modality: 'text',
  };
}
function quote(input: QuoteInput) {
  const text = input.text.replace(/[.!?;]$/, '');
  return {
    inputId: input.id,
    start: 0,
    end: text.length,
    quote: text,
  };
}
function check(assistantText: string, userText: string, itemText: string) {
  const assistant = source('assistant', assistantText, 'assistant');
  const user = source('user', userText, 'user');
  return validateSpans(
    {
      text: itemText,
      status: 'stated',
      quoteSpans: [quote(assistant), quote(user)],
    },
    [assistant, user],
    config,
  );
}
function reducerCase(userText: string, assistantText = '€10 per month.', itemText = '€10 per month') {
  const initial = initialState('s', config);
  initial.domain.inputs.push({
    id: 'assistant',
    text: assistantText,
    status: 'interpreted',
    origin: 'assistant',
  });
  const commit = parse({
    eventId: 'user-event',
    sessionId: 's',
    acceptedAt: 0,
    type: 'input.committed',
    payload: {
      clientMsgId: 'm',
      text: userText,
      modality: 'text',
    },
  });
  const state = reduce(initial, commit).state;
  const call = state.domain.call!;
  const assistant = source('assistant', assistantText, 'assistant');
  const user = source(state.domain.inputs[1]!.id, userText, 'user');
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
        ops: [
          {
            op: 'create',
            kind: 'requirement',
            status: 'stated',
            text: itemText,
            quoteSpans: [quote(assistant), quote(user)],
          },
        ],
      },
    },
  });
  return {
    state,
    event,
    result: reduce(state, event),
  };
}

describe('currency provenance', () => {
  it('caps assistant euros when the user says only the bare number', () => {
    expect(check('€10 per month.', '10 per month.', '€10 per month').reason).toBe(
      'status:forced_considering:assistant_only',
    );
  });
  it('does not equate dollars and euros', () => {
    expect(check('€10 per month.', '$10 per month.', '€10 per month').status).toBe('considering');
  });
  it('allows a shared euro amount from both origins', () => {
    expect(check('€10 per month.', '€10 per month.', '€10 per month').status).toBe('stated');
  });
  it('equates ten euros with €10', () => {
    expect(check('€10 per month.', 'ten euros per month.', '€10 per month').status).toBe('stated');
  });
  it('equates 10 EUR with €10', () => {
    expect(check('€10 per month.', '10 EUR per month.', '€10 per month').status).toBe('stated');
  });
  it('equates spelled-out larger sterling amounts', () => {
    expect(check('£120 per month.', 'one hundred twenty pounds per month.', '£120 per month').status).toBe('stated');
  });
  it('keeps the existing bare-number provenance check for an assistant amount', () => {
    expect(check('€10 per month.', 'Yes.', '10 per month').status).toBe('considering');
  });
  it('equates one thousand twenty dollars with $1020', () => {
    expect(check('$1020.', 'one thousand twenty dollars.', '$1020').status).toBe('stated');
  });
  it('does not combine number and currency from different spans', () => {
    const assistant = source('a', '€10.', 'assistant');
    const userNumber = source('b', '10.', 'user');
    const userCurrency = source('c', 'euros.', 'user');
    const result = validateSpans(
      {
        text: '€10',
        status: 'stated',
        quoteSpans: [quote(assistant), quote(userNumber), quote(userCurrency)],
      },
      [assistant, userNumber, userCurrency],
      config,
    );
    expect(result.status).toBe('considering');
  });
  it('caps the assistant-only amount through the reducer', () => {
    const { result } = reducerCase('10 per month.');
    expect(result.state.domain.items['s.2.1']?.status).toBe('considering');
    expect(result.decisions.map((decision) => decision.reason)).toContain('status:forced_considering:assistant_only');
  });
  it('allows the same euro amount through the reducer', () => {
    const { result } = reducerCase('€10 per month.');
    expect(result.state.domain.items['s.2.1']?.status).toBe('stated');
  });
  it('rejects treating €10,000 as the assistant’s €10 through the reducer', () => {
    const { result } = reducerCase('€10,000.', '€10.', '€10');
    expect(result.state.domain.items['s.2.1']?.status).toBe('considering');
  });
  it('rejects treating 10,000 euros as the assistant’s €0 through the reducer', () => {
    const { result } = reducerCase('10,000 euros.', '€0.', '€0');
    expect(result.state.domain.items['s.2.1']?.status).toBe('considering');
  });
  it('does not round adjacent large integers through the reducer', () => {
    const { result } = reducerCase('€9007199254740992.', '€9007199254740993.', '€9007199254740993');
    expect(result.state.domain.items['s.2.1']?.status).toBe('considering');
  });
  it('equates €10,000 and 10,000 euros', () => {
    expect(check('€10,000.', '10,000 euros.', '€10,000').status).toBe('stated');
  });
  it('equates €10.50 and €10.5', () => {
    expect(check('€10.50.', '€10.5.', '€10.50').status).toBe('stated');
  });
  it('leaves an ambiguous €10.000 unmatched even when both say it', () => {
    expect(extractAmounts('€10.000').amounts).toEqual(['UNMATCHED:EUR:10.000']);
    expect(check('€10.000.', '€10.000.', '€10.000').status).toBe('considering');
  });
  it('leaves a comma-decimal amount unmatched', () => {
    expect(check('€1,5.', '€1,5.', '€1,5').status).toBe('considering');
  });
  it('leaves irregular comma grouping unmatched', () => {
    expect(check('€1,23,456.', '€1,23,456.', '€1,23,456').status).toBe('considering');
  });
  it('leaves mixed grouping and decimal separators unmatched', () => {
    expect(check('€1,000.50.', '€1,000.50.', '€1,000.50').status).toBe('considering');
  });
  it('does not treat an unsupported slash continuation as a price prefix', () => {
    expect(check('€10.', '€10/20.', '€10').status).toBe('considering');
  });
  it('does not attribute an unsupported signed price to the user', () => {
    expect(check('€10.', '€-10.', '€10').status).toBe('considering');
  });
  it('normalizes leading and trailing decimal zeroes without loss', () => {
    expect(check('€00010.50.', '€10.5.', '€00010.50').status).toBe('stated');
  });
  it('I8 catches a forged stated item for a grouped-number mismatch', () => {
    const { state, event, result } = reducerCase('€10,000.', '€10.', '€10');
    const forged = structuredClone(result.state);
    forged.domain.items['s.2.1']!.status = 'stated';
    const problems = invariantRegistry.flatMap((invariant) =>
      invariant(state, event, forged, result.effects, result.decisions),
    );
    expect(problems).toContain('I8 stated without valid user wording');
  });
  it('I8 detects a forged stated item with assistant-only currency', () => {
    const { state, event, result } = reducerCase('10 per month.');
    const forged = structuredClone(result.state);
    forged.domain.items['s.2.1']!.status = 'stated';
    const problems = invariantRegistry.flatMap((invariant) =>
      invariant(state, event, forged, result.effects, result.decisions),
    );
    expect(problems).toContain('I8 stated without valid user wording');
  });
});
