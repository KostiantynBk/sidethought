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

it('permits a Deliberator to create a proposed assistant item', () => {
  const result = createItem(
    {
      items: {},
      projectRev: 0,
    },
    {
      ...op,
      origin: 'assistant',
      status: 'proposed',
      source: 'deliberator',
    },
    [source],
    config,
    identity,
  );
  expect(result.state.items['s.1.1']?.status).toBe('proposed');
});
it('rejects stale UI reject without changing the project', () => {
  const state = project('proposed');
  const result = itemAction(state, {
    itemId: 's.1.1',
    expectedVersion: 0,
    action: 'reject',
  });
  expect(result.state).toEqual(state);
  expect(result.decisions).toEqual(['action:stale_version']);
});
it('rejects stale UI edit without changing the project', () => {
  const state = project();
  const result = itemAction(state, {
    itemId: 's.1.1',
    expectedVersion: 0,
    action: 'edit',
    text: 'Cloud allowed',
  });
  expect(result.state).toEqual(state);
  expect(result.decisions).toEqual(['action:stale_version']);
});
it('lets a current UI reject a proposed item', () => {
  const result = itemAction(project('proposed'), {
    itemId: 's.1.1',
    expectedVersion: 1,
    action: 'reject',
  });
  expect(result.state.items['s.1.1']?.status).toBe('rejected');
  expect(result.state.items['s.1.1']?.contentVersion).toBe(1);
});
it('lets the Interpreter retract a stated item with a valid user quote', () => {
  const state = project();
  const result = setStatus(state, 's.1.1', 'retracted', 'interpreter', [quote], [source], config);
  expect(result.state.items['s.1.1']?.status).toBe('retracted');
  expect(result.state.projectRev).toBe(2);
});
it('lets a direct user reject a proposed item', () => {
  const state = project('proposed');
  const result = setStatus(state, 's.1.1', 'rejected', 'user', [], [source], config);
  expect(result.state.items['s.1.1']?.status).toBe('rejected');
});
it('rejects a finding trying to set an item status', () => {
  const state = project();
  const result = setStatus(state, 's.1.1', 'retracted', 'finding', [quote], [source], config);
  expect(result.state).toEqual(state);
  expect(result.decisions).toEqual(['authority:denied']);
});
it('rejects a model trying to confirm an existing item', () => {
  const state = project();
  const result = setStatus(state, 's.1.1', 'confirmed', 'interpreter', [quote], [source], config);
  expect(result.state).toEqual(state);
  expect(result.decisions).toEqual(['authority:denied']);
});
it('does not increment revisions for an unchanged edit', () => {
  const state = project();
  const result = itemAction(state, {
    itemId: 's.1.1',
    expectedVersion: 1,
    action: 'edit',
    text: 'No cloud, ever',
  });
  expect(result.state).toEqual(state);
});
it('lets a user commit a previously hedged item with a new quote', () => {
  const hedged = {
    ...source,
    text: 'Maybe use encryption.',
  };
  const stated = {
    ...source,
    id: 'new',
    text: 'Use encryption.',
  };
  const first = createItem(
    {
      items: {},
      projectRev: 0,
    },
    {
      ...op,
      text: 'Use encryption',
      quoteSpans: [
        {
          inputId: 'user',
          start: 0,
          end: 20,
          quote: 'Maybe use encryption',
        },
      ],
    },
    [hedged],
    config,
    identity,
  ).state;
  const result = setStatus(
    first,
    's.1.1',
    'stated',
    'interpreter',
    [
      {
        inputId: 'new',
        start: 0,
        end: 14,
        quote: 'Use encryption',
      },
    ],
    [hedged, stated],
    config,
  );
  expect(result.state.items['s.1.1']?.status).toBe('stated');
  expect(result.state.items['s.1.1']?.contentVersion).toBe(1);
  expect(result.state.items['s.1.1']?.provenance.quoteSpans[0]?.inputId).toBe('new');
});
it('flags any item extracted from voice even without an obvious name or number', () => {
  const voice = {
    ...source,
    text: 'local notes',
    modality: 'voice' as const,
  };
  const result = createItem({
    items: {},
    projectRev: 0,
  }, {
    ...op,
    text: voice.text,
    quoteSpans: [{
      inputId: 'user',
      start: 0,
      end: voice.text.length,
      quote: voice.text,
    }],
  }, [voice], config, identity);
  expect(result.state.items['s.1.1']?.voiceConfirmNeeded).toBe(true);
});
it('marks voice-origin project names for confirmation', () => {
  const voice = {
    ...source,
    text: 'Sidethought',
    modality: 'voice' as const,
  };
  const result = createItem(
    {
      items: {},
      projectRev: 0,
    },
    {
      ...op,
      kind: 'name',
      text: voice.text,
      quoteSpans: [
        {
          inputId: 'user',
          start: 0,
          end: voice.text.length,
          quote: voice.text,
        },
      ],
    },
    [voice],
    config,
    identity,
  );
  expect(result.state.items['s.1.1']?.voiceConfirmNeeded).toBe(true);
});
