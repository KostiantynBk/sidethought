import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createItem, itemAction, setStatus, validateSpans, type ItemOp } from '../src/kernel/items/index.js';

const config = loadConfig();
const source = {
  id: 'user',
  text: 'No cloud, ever.',
  origin: 'user' as const,
  modality: 'text' as const,
};
const quote = {
  inputId: 'user',
  start: 0,
  end: 14,
  quote: 'No cloud, ever',
};
const op: ItemOp = {
  kind: 'requirement',
  status: 'stated',
  text: 'No cloud, ever',
  quoteSpans: [quote],
  origin: 'user',
  source: 'interpreter',
  private: false,
};
const identity = {
  sessionId: 's',
  seq: 1,
  n: 1,
};
function project(status: 'stated' | 'proposed' = 'stated') {
  return createItem(
    {
      items: {},
      projectRev: 0,
    },
    {
      ...op,
      status,
      origin: status === 'proposed' ? 'assistant' : 'user',
    },
    [source],
    config,
    identity,
  ).state;
}

it('allows negation inside the whole cited clause', () => {
  expect(validateSpans(op, [source], config).status).toBe('stated');
});
it('does not treat a comma as a clause boundary', () => {
  const partial = {
    ...op,
    quoteSpans: [
      {
        ...quote,
        end: 8,
        quote: 'No cloud',
      },
    ],
  };
  expect(validateSpans(partial, [source], config).reason).toBe('span:partial_clause');
});
it('normalizes case and whitespace runs in matching quotes', () => {
  const input = {
    ...source,
    text: 'Hello  WORLD',
  };
  const proposal = {
    ...op,
    quoteSpans: [
      {
        inputId: 'user',
        start: 0,
        end: input.text.length,
        quote: 'hello world',
      },
    ],
  };
  expect(validateSpans(proposal, [input], config).reason).toBe('span:valid');
});
it('uses the configured hedge lexicon', () => {
  const input = {
    ...source,
    text: 'Uncertain about hosting',
  };
  const proposal = {
    ...op,
    quoteSpans: [
      {
        inputId: 'user',
        start: 0,
        end: input.text.length,
        quote: input.text,
      },
    ],
  };
  const custom = loadConfig({
    hedgeLexicon: ['uncertain'],
  });
  expect(validateSpans(proposal, [input], custom).status).toBe('considering');
});
it('rejects an unknown input ID', () => {
  const proposal = {
    ...op,
    quoteSpans: [
      {
        ...quote,
        inputId: 'unknown',
      },
    ],
  };
  expect(validateSpans(proposal, [source], config).reason).toBe('span:mismatch');
});
it('rejects offsets beyond the source', () => {
  const proposal = {
    ...op,
    quoteSpans: [
      {
        ...quote,
        end: 100,
      },
    ],
  };
  expect(validateSpans(proposal, [source], config).reason).toBe('span:mismatch');
});
it('requires at least one quote for a user statement', () => {
  const proposal = {
    ...op,
    quoteSpans: [],
  };
  expect(validateSpans(proposal, [source], config).reason).toBe('span:mismatch');
});
it('caps an interrogative beginning without a question mark', () => {
  const input = {
    ...source,
    text: 'Which database',
  };
  const proposal = {
    ...op,
    text: input.text,
    quoteSpans: [
      {
        inputId: 'user',
        start: 0,
        end: input.text.length,
        quote: input.text,
      },
    ],
  };
  expect(validateSpans(proposal, [input], config).reason).toBe('status:capped:question');
});
