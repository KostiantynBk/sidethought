import { expect, it } from 'vitest';
import { resolveQuoteSpan, validateSpans, type QuoteInput } from '../src/kernel/items/spans.js';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { invariantRegistry } from '../src/harness/index.js';
import { config, parse, readyOutput } from './t03-helpers.js';

function source(text: string): QuoteInput {
  return {
    id: 'u',
    text,
    origin: 'user',
    modality: 'text',
  };
}

function span(quote: string, start = 0, end = 1) {
  return {
    inputId: 'u',
    start,
    end,
    quote,
  };
}

function resolve(text: string, quote: string) {
  return resolveQuoteSpan(span(quote), source(text));
}

function commit(state: State, text: string, id = 'm1') {
  return reduce(state, parse({
    eventId: id,
    sessionId: 's',
    acceptedAt: 0,
    type: 'input.committed',
    payload: {
      clientMsgId: id,
      text,
      modality: 'text',
    },
  })).state;
}

function complete(state: State, ops: object[]) {
  const call = state.domain.call!;
  const event = parse({
    eventId: `ready-${state.meta.seq}`,
    sessionId: 's',
    acceptedAt: 1,
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
        ops,
      },
    },
  });
  return {
    event,
    result: reduce(state, event),
  };
}

function create(inputId: string, quote: string, start = 0, end = 1) {
  return {
    op: 'create',
    kind: 'requirement',
    status: 'stated',
    text: quote,
    quoteSpans: [{
      inputId,
      start,
      end,
      quote,
    }],
  };
}

it('keeps correct offsets without a decision even when the quote occurs twice', () => {
  const original = span('ten', 0, 3);
  expect(resolveQuoteSpan(original, source('ten ten'))).toEqual({ span: original });
});

it('stores uniquely resolved offsets and preserves the status of a correct span', () => {
  const text = 'Use local storage';
  const started = commit(initialState('s', config), text);
  const inputId = started.domain.inputs[0]!.id;
  const wrong = complete(started, [create(inputId, text)]).result;
  const right = complete(started, [create(inputId, text, 0, text.length)]).result;
  const item = Object.values(wrong.state.domain.items)[0]!;
  expect(item.status).toBe(Object.values(right.state.domain.items)[0]!.status);
  expect(item.provenance.quoteSpans).toEqual([{
    inputId,
    start: 0,
    end: text.length,
    quote: text,
  }]);
  expect(wrong.decisions.map(d => d.reason)).toContain('span:resolved_by_quote');
});

it('resolves an out-of-range end when the quote is unique', () => {
  const result = resolveQuoteSpan(span('local', 0, 100), source('Use local storage'));
  expect(result).toEqual({
    span: span('local', 4, 9),
    decision: 'span:resolved_by_quote',
  });
});

it('maps case, curly quotes, dashes and whitespace normalization back to the raw slice', () => {
  const text = 'Prefix: “HELLO”  world—\nagain!';
  const quote = '"hello" world- again';
  const result = resolve(text, quote);
  expect(result.decision).toBe('span:resolved_by_quote');
  expect(text.slice(result.span.start, result.span.end)).toBe('“HELLO”  world—\nagain');
});

it('finds ten as a word and not inside often', () => {
  expect(resolve('I often pay ten euros', 'ten')).toEqual({
    span: span('ten', 12, 15),
    decision: 'span:resolved_by_quote',
  });
});

it('does not find ten inside often', () => {
  expect(resolve('often', 'ten').decision).toBe('span:quote_not_found');
});

it('rejects ambiguous quotes before mismatch and starts the retry route', () => {
  const started = commit(initialState('s', config), 'ten and ten');
  const inputId = started.domain.inputs[0]!.id;
  const result = complete(started, [create(inputId, 'ten')]).result;
  const reasons = result.decisions.map(d => d.reason);
  expect(reasons.indexOf('span:quote_ambiguous')).toBeGreaterThanOrEqual(0);
  expect(reasons.indexOf('span:mismatch')).toBeGreaterThan(reasons.indexOf('span:quote_ambiguous'));
  expect(result.effects.some(effect => effect.type === 'llm.call' && effect.role === 'interpreter')).toBe(true);
});

it('checks the raw word boundary after a lowercase-expanding character', () => {
  const result = resolveQuoteSpan(span('İ', 1, 2), source('İx'));
  expect(result.decision).toBe('span:quote_not_found');
});

it('counts overlapping occurrences as ambiguous', () => {
  expect(resolve('na na na', 'na na').decision).toBe('span:quote_ambiguous');
});

it('reports a missing quote before mismatch', () => {
  const started = commit(initialState('s', config), 'Use local storage');
  const result = complete(started, [create(started.domain.inputs[0]!.id, 'missing')]).result;
  const reasons = result.decisions.map(d => d.reason);
  expect(reasons.indexOf('span:quote_not_found')).toBeGreaterThanOrEqual(0);
  expect(reasons.indexOf('span:mismatch')).toBeGreaterThan(reasons.indexOf('span:quote_not_found'));
});

it('does not search an unrelated input for the quote', () => {
  const started = commit(initialState('s', config), 'Earlier input');
  const firstQueued = commit(started, 'Use local storage', 'm2');
  const secondQueued = commit(firstQueued, 'Remote backup', 'm3');
  const batched = complete(secondQueued, []).result.state;
  const citedId = batched.domain.inputs[1]!.id;
  const otherId = batched.domain.inputs[2]!.id;
  expect(batched.domain.call!.inputIds).toEqual([citedId, otherId]);
  const result = complete(batched, [create(citedId, 'Remote backup')]).result;
  expect(result.decisions.map(d => d.reason)).toContain('span:quote_not_found');
});

it('still rejects a partial clause after resolving its span', () => {
  const input = source('Use local storage only');
  const resolved = resolve(input.text, 'local storage').span;
  expect(validateSpans({
    text: 'local storage',
    status: 'stated',
    quoteSpans: [resolved],
  }, [input], config).reason)
    .toBe('span:partial_clause');
});

it('still forces a resolved hedged clause to considering', () => {
  const input = source('Maybe use local storage');
  const resolved = resolve(input.text, input.text).span;
  expect(validateSpans({
    text: input.text,
    status: 'stated',
    quoteSpans: [resolved],
  }, [input], config).status)
    .toBe('considering');
});

it('still rejects negation outside a resolved span', () => {
  const input = source('Never use cloud');
  const resolved = resolve(input.text, 'use cloud').span;
  expect(validateSpans({
    text: 'use cloud',
    status: 'stated',
    quoteSpans: [resolved],
  }, [input], config).reason)
    .toBe('span:negated_outside');
});

it('resolves replacement spans in a supersede operation', () => {
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
  const text = 'Use local storage';
  const started = commit(initial, text);
  const inputId = started.domain.inputs[0]!.id;
  const result = complete(started, [{
    op: 'supersede',
    itemId: 'r1',
    quoteSpans: [{
      inputId,
      start: 0,
      end: text.length,
      quote: text,
    }],
    replacement: {
      kind: 'requirement',
      status: 'stated',
      text,
      quoteSpans: [{
        inputId,
        start: 0,
        end: 1,
        quote: text,
      }],
    },
  }]).result;
  const item = Object.values(result.state.domain.items).find(entry => entry.text === text)!;
  expect(item.provenance.quoteSpans).toEqual([{
    inputId,
    start: 0,
    end: text.length,
    quote: text,
  }]);
  expect(result.decisions.map(d => d.reason)).toContain('span:resolved_by_quote');
});

it('maps offsets after lowercase expansion and a surrogate-pair emoji', () => {
  const text = 'İ😀 use local storage';
  const result = resolve(text, 'local storage');
  expect(result.decision).toBe('span:resolved_by_quote');
  expect(result.span.start).toBe(text.indexOf('local'));
  expect(text.slice(result.span.start, result.span.end)).toBe('local storage');
});

it('leaves an unknown input unchanged with no resolution decision', () => {
  const original = span('hello');
  expect(resolveQuoteSpan(original, undefined)).toEqual({ span: original });
});

it('passes the invariant registry after storing a resolved span', () => {
  const text = 'Use local storage';
  const before = commit(initialState('s', config), text);
  const { event, result } = complete(before, [create(before.domain.inputs[0]!.id, text)]);
  expect(invariantRegistry.flatMap(check => check(before, event, result.state, result.effects, result.decisions)))
    .toEqual([]);
});
