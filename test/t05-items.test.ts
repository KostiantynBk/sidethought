import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import {
  createItem,
  itemAction,
  updateItem,
  setStatus,
  supersedeItem,
  validateSpans,
  verbalAgreement,
  type ItemOp,
  type QuoteInput,
} from '../src/kernel/items/index.js';

const config = loadConfig();
const identity = {
  sessionId: 's',
  seq: 1,
  n: 1,
};
const empty = {
  items: {},
  projectRev: 0,
};
function input(id: string, text: string, origin: QuoteInput['origin'] = 'user'): QuoteInput {
  return {
    id,
    text,
    origin,
    modality: 'text',
  };
}
function span(value: QuoteInput) {
  const quote = value.text.replace(/[.!?;]$/, '');
  return {
    inputId: value.id,
    start: 0,
    end: quote.length,
    quote,
  };
}
function op(value: QuoteInput): ItemOp {
  return {
    kind: 'requirement',
    status: 'stated',
    text: value.text,
    quoteSpans: [span(value)],
    origin: 'user',
    source: 'interpreter',
    private: false,
  };
}
function created(value: QuoteInput, override: Partial<ItemOp> = {}) {
  return createItem(
    empty,
    {
      ...op(value),
      ...override,
    },
    [value],
    config,
    identity,
  );
}

describe('quote checks', () => {
  it('caps a hedge across combined spans (S5)', () => {
    const first = input('a', 'I was thinking ten euros a month.');
    const second = input('b', 'What customers pay.');
    const result = validateSpans(
      {
        text: 'customer price: €10 per month',
        status: 'stated',
        quoteSpans: [span(first), span(second)],
      },
      [first, second],
      config,
    );
    expect(result.reason).toBe('status:forced_considering:hedge');
    expect(result.status).toBe('considering');
  });
  it('forces a hedged declarative clause to considering', () => {
    const value = input('a', 'Maybe use encryption.');
    expect(created(value).state.items['s.1.1']?.status).toBe('considering');
  });
  it('rejects negation outside the span', () => {
    const value = input('a', 'Do not use cloud.');
    const result = validateSpans(
      {
        text: 'use cloud',
        status: 'stated',
        quoteSpans: [
          {
            inputId: 'a',
            start: 7,
            end: 16,
            quote: 'use cloud',
          },
        ],
      },
      [value],
      config,
    );
    expect(result.reason).toBe('span:negated_outside');
  });
  it('caps a user question (5d)', () => {
    const value = input('a', 'Anything like Notion for this?');
    expect(validateSpans(op(value), [value], config).reason).toBe('status:capped:question');
  });
  it('caps assistant-only value tokens (5c)', () => {
    const assistant = input('a', 'So €10 a month, billed yearly?', 'assistant');
    const user = input('b', 'Yes.');
    const result = validateSpans(
      {
        text: '€10 per month, billed yearly',
        status: 'stated',
        quoteSpans: [span(assistant), span(user)],
      },
      [assistant, user],
      config,
    );
    expect(result.reason).toBe('status:forced_considering:assistant_only');
  });
  it('caps assistant-only values even without a question', () => {
    const assistant = input('a', 'The subscription is billed yearly.', 'assistant');
    const user = input('b', 'Yes.');
    const result = validateSpans(
      {
        text: 'billed yearly',
        status: 'stated',
        quoteSpans: [span(assistant), span(user)],
      },
      [assistant, user],
      config,
    );
    expect(result.status).toBe('considering');
    expect(result.reason).toBe('status:forced_considering:assistant_only');
  });
  it('accepts a plain user statement', () => {
    const value = input('a', 'Notes stay on the phone.');
    expect(created(value).state.items['s.1.1']?.status).toBe('stated');
  });
  it('rejects a partial clause', () => {
    const value = input('a', 'Notes stay on the phone.');
    const result = validateSpans(
      {
        text: 'Notes stay',
        status: 'stated',
        quoteSpans: [
          {
            inputId: 'a',
            start: 0,
            end: 10,
            quote: 'Notes stay',
          },
        ],
      },
      [value],
      config,
    );
    expect(result.reason).toBe('span:partial_clause');
  });
  it('rejects mismatched quoted words', () => {
    const value = input('a', 'Notes stay on the phone.');
    const proposal = op(value);
    proposal.quoteSpans[0]!.quote = 'different quote';
    expect(validateSpans(proposal, [value], config).reason).toBe('span:mismatch');
  });
  it('normalizes curly quotes, case, whitespace and dash variants', () => {
    const value = input('a', '“Hello”—world');
    const proposal = op(value);
    proposal.quoteSpans[0]!.quote = '"HELLO"-world';
    expect(validateSpans(proposal, [value], config).reason).toBe('span:valid');
  });
});

