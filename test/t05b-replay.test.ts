import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';
import { initialState, reduce } from '../src/kernel/index.js';
import { MemoryStore, SqliteStore, type JournalEvent } from '../src/store/index.js';
import { config } from './t03-helpers.js';

function replay(name: string, kind: 'memory' | 'sqlite') {
  const directory = mkdtempSync(join(tmpdir(), 't05b-replay-'));
  const path = join(directory, 'test.sqlite');
  const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(path);
  const close = store.close.bind(store);
  let journal: JournalEvent[] = [];
  store.close = () => {
    if (kind === 'memory') journal = store.readJournal('s');
    close();
    if (kind === 'sqlite') {
      const reopened = new SqliteStore(path);
      journal = reopened.readJournal('s');
      reopened.close();
    }
  };
  try {
    const result = replayFixture(`fixtures/t05b/${name}.json`, {
      store: kind,
      storeFactory: () => store,
    });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.unflushedTelemetry).toEqual([]);
    expect(journal.length).toBeGreaterThan(0);
    if (name === 'quote-resolved') {
      const ready = journal.find(event => event.type === 'interpretation.ready');
      expect(ready).toMatchObject({
        payload: {
          output: {
            ops: [{
              quoteSpans: [{
                start: 0,
                end: 1,
                quote: 'Use local storage',
              }],
            }],
          },
        },
      });
      const item = Object.values(result.snapshot!.state.domain.items)[0]!;
      expect(item.provenance.quoteSpans[0]).toMatchObject({
        start: 0,
        end: 17,
        quote: 'Use local storage',
      });
    }
    const replayed = journal.reduce((state, event) => reduce(state, event).state, initialState('s', config));
    expect(replayed).toEqual(result.snapshot!.state);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('replays a resolved quote in memory and real SQLite including persisted journals', () => {
  const memory = replay('quote-resolved', 'memory');
  const sqlite = replay('quote-resolved', 'sqlite');
  expect(sqlite.snapshot).toEqual(memory.snapshot);
  const item = Object.values(memory.snapshot!.state.domain.items)[0]!;
  expect(item.status).toBe('stated');
  expect(item.provenance.quoteSpans[0]).toMatchObject({
    start: 0,
    end: 17,
    quote: 'Use local storage',
  });
  expect(memory.projection!.decisions.map(d => d.reason)).toContain('span:resolved_by_quote');
});

it('replays an ambiguous quote and retry in memory and real SQLite including persisted journals', () => {
  const memory = replay('quote-ambiguous', 'memory');
  const sqlite = replay('quote-ambiguous', 'sqlite');
  expect(sqlite.snapshot).toEqual(memory.snapshot);
  const reasons = memory.projection!.decisions.map(d => d.reason);
  expect(reasons).toContain('interpreter:retry');
  expect(reasons.indexOf('span:quote_ambiguous')).toBeGreaterThanOrEqual(0);
  expect(reasons.indexOf('span:mismatch')).toBeGreaterThan(reasons.indexOf('span:quote_ambiguous'));
  expect(memory.snapshot!.state.domain.call?.attempt).toBe(2);
  expect(Object.keys(memory.snapshot!.state.domain.items)).toHaveLength(0);
});
