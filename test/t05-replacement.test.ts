import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createItem, supersedeItem, type ItemOp, type QuoteInput } from '../src/kernel/items/index.js';

const config = loadConfig();
const text: QuoteInput = {
  id: 'text',
  text: 'Use cloud.',
  origin: 'user',
  modality: 'text',
};
const voice: QuoteInput = {
  id: 'voice',
  text: 'Use local storage.',
  origin: 'user',
  modality: 'voice',
};
const oldOp: ItemOp = {
  kind: 'requirement',
  status: 'stated',
  text: 'Use cloud',
  quoteSpans: [
    {
      inputId: 'text',
      start: 0,
      end: 9,
      quote: 'Use cloud',
    },
  ],
  origin: 'user',
  source: 'interpreter',
  private: false,
};
function setup() {
  const created = createItem(
    {
      items: {},
      projectRev: 0,
    },
    oldOp,
    [text],
    config,
    {
      sessionId: 's',
      seq: 1,
      n: 1,
    },
  );
  const replacement = {
    ...created.state.items['s.1.1']!,
    id: 's.2.1',
    text: 'Use local storage',
    provenance: {
      origin: 'user' as const,
      quoteSpans: [
        {
          inputId: 'voice',
          start: 0,
          end: 17,
          quote: 'Use local storage',
        },
      ],
    },
    voiceConfirmNeeded: false,
  };
  return {
    state: created.state,
    replacement,
  };
}
it('flags a plain-word supersede replacement originating from voice', () => {
  const { state, replacement } = setup();
  const result = supersedeItem(state, 's.1.1', replacement, 'interpreter', [text, voice], config);
  expect(result.state.items['s.1.1']?.status).toBe('superseded');
  expect(result.state.items['s.2.1']?.voiceConfirmNeeded).toBe(true);
});
it('never clears an already true replacement voice flag', () => {
  const { state, replacement } = setup();
  replacement.voiceConfirmNeeded = true;
  const textOnly: QuoteInput = {
    ...voice,
    modality: 'text',
  };
  const result = supersedeItem(state, 's.1.1', replacement, 'interpreter', [text, textOnly], config);
  expect(result.state.items['s.2.1']?.voiceConfirmNeeded).toBe(true);
});
