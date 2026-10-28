import { expect, it } from 'vitest';
import type { Item } from '../src/contract/index.js';
import { invariantRegistry } from '../src/harness/index.js';
import { initialState } from '../src/kernel/index.js';
import { config, parse } from './t03-helpers.js';

const item: Item = {
  id: 'p',
  kind: 'option',
  status: 'proposed',
  text: 'Encryption',
  contentVersion: 2,
  private: false,
  provenance: {
    origin: 'assistant',
    quoteSpans: [],
  },
  voiceConfirmNeeded: false,
};
function violations(before: ReturnType<typeof initialState>, event: ReturnType<typeof parse>, after: typeof before) {
  return invariantRegistry.flatMap((invariant) => invariant(before, event, after, [], []));
}
it('I8 detects confirmation not caused by a UI confirm', () => {
  const before = initialState('s', config);
  before.domain.items.p = item;
  const after = structuredClone(before);
  after.meta.seq++;
  after.domain.items.p!.status = 'confirmed';
  const event = parse({
    eventId: 'e',
    sessionId: 's',
    acceptedAt: 1,
    type: 'client.disconnected',
    payload: {},
  });
  expect(violations(before, event, after)).toContain('I8 confirmed without UI confirm');
});
it('I8 detects a stated preference extracted from a question', () => {
  const before = initialState('s', config);
  const after = structuredClone(before);
  after.meta.seq++;
  after.domain.inputs.push({
    id: 'input',
    text: 'Anything like Notion?',
    status: 'interpreted',
  });
  after.domain.items.p = {
    ...item,
    status: 'stated',
    provenance: {
      origin: 'user',
      quoteSpans: [
        {
          inputId: 'input',
          start: 0,
          end: 20,
          quote: 'Anything like Notion',
        },
      ],
    },
  };
  const event = parse({
    eventId: 'e',
    sessionId: 's',
    acceptedAt: 1,
    type: 'client.disconnected',
    payload: {},
  });
  expect(violations(before, event, after)).toContain('I8 stated without valid user wording');
});
it('I16 detects a stale item action that changed the project', () => {
  const before = initialState('s', config);
  before.domain.items.p = item;
  const after = structuredClone(before);
  after.meta.seq++;
  after.domain.items.p!.status = 'confirmed';
  after.domain.projectRev++;
  const event = parse({
    eventId: 'e',
    sessionId: 's',
    acceptedAt: 1,
    type: 'item.action',
    payload: {
      itemId: 'p',
      expectedVersion: 1,
      action: 'confirm',
    },
  });
  expect(violations(before, event, after)).toContain('I16 stale action changed project');
});
