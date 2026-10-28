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

describe('item authority', () => {
  it('rejects a model-created confirmation', () => {
    const value = input('a', 'Use encryption.');
    expect(created(value, { status: 'confirmed' }).decisions).toEqual(['authority:denied']);
  });
  it('records agreement without confirming (2c)', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value, {
      origin: 'assistant',
      status: 'proposed',
    }).state;
    const result = verbalAgreement(initial, 's.1.1');
    expect(result.state.items['s.1.1']?.status).toBe('proposed');
    expect(result.state.items['s.1.1']?.verbalConfirmPending).toBe(true);
  });
  it('confirms by UI tap (2d)', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value, {
      origin: 'assistant',
      status: 'proposed',
    }).state;
    const result = itemAction(initial, {
      itemId: 's.1.1',
      expectedVersion: 1,
      action: 'confirm',
    });
    expect(result.state.items['s.1.1']?.status).toBe('confirmed');
    expect(result.state.items['s.1.1']?.contentVersion).toBe(1);
  });
  it('rejects a stale UI version', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const result = itemAction(initial, {
      itemId: 's.1.1',
      expectedVersion: 0,
      action: 'confirm',
    });
    expect(result.state).toEqual(initial);
    expect(result.decisions).toEqual(['action:stale_version']);
  });
  it('increments content version on edit', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const result = itemAction(initial, {
      itemId: 's.1.1',
      expectedVersion: 1,
      action: 'edit',
      text: 'Use TLS.',
    });
    expect(result.state.items['s.1.1']?.contentVersion).toBe(2);
    expect(result.state.projectRev).toBe(2);
  });
  it('rejects model text edits', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    expect(updateItem(initial, 's.1.1', 'Use TLS.', 'interpreter').decisions).toEqual(['authority:edit_user_only']);
  });
  it('rejects a finding attempting to create an item', () => {
    const value = input('a', 'Use encryption.');
    expect(created(value, { source: 'finding' }).decisions).toEqual(['authority:denied']);
  });
  it('requires a user span for stated status', () => {
    const value = input('a', 'Use encryption.', 'assistant');
    expect(created(value).decisions).toEqual(['authority:user_span_required']);
  });
  it('rejects assistant-origin items that do not start proposed', () => {
    const value = input('a', 'Use encryption.');
    expect(created(value, { origin: 'assistant' }).decisions).toEqual(['authority:denied']);
  });
  it('allows the user to retract an item without changing its content version', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const result = setStatus(initial, 's.1.1', 'retracted', 'user', [], [value], config);
    expect(result.state.items['s.1.1']?.status).toBe('retracted');
    expect(result.state.items['s.1.1']?.contentVersion).toBe(1);
    expect(result.state.projectRev).toBe(2);
  });
  it('rejects a retraction without a valid interpreter quote', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const result = setStatus(initial, 's.1.1', 'retracted', 'interpreter', [], [value], config);
    expect(result.state).toEqual(initial);
  });
  it('marks spoken numbers for UI confirmation', () => {
    const value: QuoteInput = {
      ...input('a', 'Price is ten euros.'),
      modality: 'voice',
    };
    expect(created(value).state.items['s.1.1']?.voiceConfirmNeeded).toBe(true);
  });
  it('treats an identical normalized replacement as a no-op', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const replacement = {
      ...initial.items['s.1.1']!,
      id: 's.2.1',
      text: 'use encryption.',
    };
    const result = supersedeItem(initial, 's.1.1', replacement, 'user', [value], config);
    expect(result.state).toEqual(initial);
    expect(result.decisions).toEqual(['noop:unchanged']);
  });
  it('supersedes an old item when the user supplies a valid replacement', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const replacement = {
      ...initial.items['s.1.1']!,
      id: 's.2.1',
      text: 'Use TLS.',
    };
    const result = supersedeItem(initial, 's.1.1', replacement, 'user', [value], config);
    expect(result.state.items['s.1.1']?.status).toBe('superseded');
    expect(result.state.items['s.2.1']?.text).toBe('Use TLS.');
    expect(result.state.projectRev).toBe(2);
  });
  it('rejects a replacement without a kernel-format ID', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const replacement = {
      ...initial.items['s.1.1']!,
      id: 'model-id',
      text: 'Use TLS.',
    };
    const result = supersedeItem(initial, 's.1.1', replacement, 'user', [value], config);
    expect(result.state).toEqual(initial);
    expect(result.decisions).toEqual(['item:invalid_id']);
  });
  it('rejects a forged confirmed replacement', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const replacement = {
      ...initial.items['s.1.1']!,
      id: 's.2.1',
      text: 'Use TLS.',
      status: 'confirmed' as const,
    };
    const result = supersedeItem(initial, 's.1.1', replacement, 'user', [value], config);
    expect(result.state).toEqual(initial);
  });
  it('defers deletion to T08', () => {
    const value = input('a', 'Use encryption.');
    const initial = created(value).state;
    const result = itemAction(initial, {
      itemId: 's.1.1',
      expectedVersion: 1,
      action: 'delete',
    });
    expect(result.decisions).toEqual(['noop:deferred_T08']);
    expect(result.state).toEqual(initial);
  });
});
