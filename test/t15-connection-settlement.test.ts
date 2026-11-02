import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { recentTurns } from '../src/context/recent.js';
import { initialState, reduce } from '../src/kernel/index.js';
import { projectState } from '../src/server/projection.js';
import { ContributionHarness, scores } from './t12a-helpers.js';

type Store = 'memory' | 'sqlite';

function reply(kind: Store) {
  const h = new ContributionHarness(kind, {}, []);
  h.connect();
  const item = h.statement('Use local storage.');
  h.timer('replyDebounce');
  const owner = h.state.domain.reply!;
  h.send('reply.chunk', {
    requestId: owner.requestId,
    callId: owner.callId,
    text: 'First useful sentence. Second unseen sentence. ',
  });
  h.send('delivery.progress', {
    deliveryId: owner.deliveryId,
    chunkIdx: 0,
    chars: 13,
    final: false,
    reason: 'rendered',
  });
  return { h, owner, item };
}

function nominate(h: ContributionHarness, item: string): void {
  h.nominate([{
    kind: 'insight',
    topic: 'Storage',
    insight: 'Use local storage.',
    depItemIds: [item],
    scores,
  }]);
}

for (const kind of ['memory', 'sqlite'] as const) {
  it(`${kind}: a disconnected reply releases the floor for an unprompted contribution after the gap`, () => {
    const { h, item } = reply(kind);
    nominate(h, item);
    h.send('client.disconnected', {});
    h.connect();
    h.timer('floorGap');
    h.check();
    h.acknowledge();
    expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('delivered');
    h.store.close();
  });

  it(`${kind}: context contains only the whole-word acknowledged prefix and marker`, () => {
    const { h, owner } = reply(kind);
    h.send('client.disconnected', {});
    const delivery = h.state.domain.deliveries[owner.deliveryId]!;
    expect(delivery.interruptedPrefix).toBe('First useful');
    expect(recentTurns(h.state.domain, 20).find(turn => turn.id === delivery.id)?.text)
      .toBe('[interrupted after: First useful]');
    expect(projectState(h.state).possiblyDelivered[0]?.text).toBe('sentence. Second unseen sentence. ');
    h.store.close();
  });

  it(`${kind}: reconnect never re-sends an old chunk and aborts the active responder`, () => {
    const { h, owner } = reply(kind);
    const disconnected = h.send('client.disconnected', {});
    expect(disconnected.effects).toContainEqual({ type: 'llm.abort', callId: owner.callId });
    const connected = h.send('client.connected', { modality: 'text' });
    expect(connected.effects.some(effect => effect.type === 'client.send'
      && effect.message.type === 'assistant.chunk' && effect.message.deliveryId === owner.deliveryId)).toBe(false);
    expect(projectState(h.state).streamingChunks).toEqual([]);
    h.store.close();
  });

  it(`${kind}: connection settles an old open completed reply without a disconnect`, () => {
    const { h, owner } = reply(kind);
    h.send('reply.done', { requestId: owner.requestId, callId: owner.callId });
    h.send('client.connected', { modality: 'text' });
    const delivery = h.state.domain.deliveries[owner.deliveryId]!;
    expect(delivery.settled).toBe(true);
    expect(delivery.state).toBe('interrupted');
    expect(delivery.interruptedPrefix).toBe('First useful');
    h.store.close();
  });

  it(`${kind}: disconnected promised evidence becomes a card without a second closure`, () => {
    const h = new ContributionHarness(kind);
    h.connect();
    h.request();
    h.passReply();
    h.at += 3000;
    const text = 'Edits work offline.';
    const url = 'https://example.com';
    h.complete(undefined, {
      verdict: 'supported',
      claims: [{ text, support: [{ url, quote: text, sourceKind: 'official' }] }],
      caveats: [],
    }, {
      completedSearchCalls: 1,
      issuedQueries: ['Provider A offline'],
      results: [{ url, snippet: text }],
    });
    h.check(text);
    const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'evidence')!;
    expect(candidate.state).toBe('delivering');
    h.send('client.disconnected', {});
    h.connect();
    expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('card_only');
    expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
    expect(Object.values(h.state.domain.initiative.candidates).some(c => c.payload === 'closure')).toBe(false);
    h.store.close();
  });
}

it('replays the same connection events deterministically in memory and SQLite', () => {
  const memory = reply('memory');
  const sqlite = reply('sqlite');
  for (const run of [memory, sqlite]) {
    run.h.send('client.disconnected', {});
    run.h.connect();
  }
  const memoryJournal = memory.h.store.readJournal('s');
  const sqliteJournal = sqlite.h.store.readJournal('s');
  expect(sqliteJournal).toEqual(memoryJournal);
  const replay = (events: typeof memoryJournal) => events.reduce(
    (state, event) => reduce(state, event).state,
    initialState('s', loadConfig({})),
  );
  expect(replay(memoryJournal)).toEqual(memory.h.state);
  expect(replay(sqliteJournal)).toEqual(sqlite.h.state);
  expect(sqlite.h.state).toEqual(memory.h.state);
  expect(sqlite.h.effects).toEqual(memory.h.effects);
  memory.h.store.close();
  sqlite.h.store.close();
});
