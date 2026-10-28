import { describe, expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';
import { MemoryStore, type JournalEvent, type Snapshot } from '../src/store/index.js';

class CorruptingStore extends MemoryStore {
  override commit(sessionId: string, events: JournalEvent[], snapshot: Snapshot): void {
    const corrupted = structuredClone(snapshot);
    corrupted.state.domain.lastFloorActivity = 123456;
    super.commit(sessionId, events, corrupted);
  }
}

describe('store-backed replay harness', () => {
  it('fails when an adapter corrupts the persisted snapshot', () => {
    const result = replayFixture('fixtures/t04/dup-eventid-clientmsgid.json', {
      store: 'memory',
      storeFactory: () => new CorruptingStore(),
    });
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeDefined();
    expect(result.failures).toContainEqual({
      class: 'invariant',
      message: 'persisted snapshot differs from committed state',
    });
  });

  it('reports an unflushed telemetry suffix separately from the persisted snapshot', () => {
    const path = 'fixtures/t04/unflushed-voice-activity.json';
    const memory = replayFixture(path, { store: 'memory' });
    const sqlite = replayFixture(path, { store: 'sqlite' });
    expect(memory.ok).toBe(true);
    expect(sqlite.ok).toBe(true);
    expect(memory.snapshot).toBeDefined();
    expect(sqlite.snapshot).toBeDefined();
    expect(memory.snapshot).toEqual(sqlite.snapshot);
    expect(memory.snapshot?.seq).toBe(1);
    expect(memory.unflushedTelemetry).toEqual(sqlite.unflushedTelemetry);
    expect(memory.unflushedTelemetry?.map(event => event.eventId)).toEqual(['voice-ping']);
  });

  it('runs the I6 fixture through both stores with identical snapshots', () => {
    const path = 'fixtures/t04/dup-eventid-clientmsgid.json';
    const memory = replayFixture(path, { store: 'memory' });
    const sqlite = replayFixture(path, { store: 'sqlite' });
    expect(memory.failures).toEqual([]);
    expect(sqlite.failures).toEqual([]);
    expect(memory.snapshot).toBeDefined();
    expect(sqlite.snapshot).toBeDefined();
    expect(memory.snapshot).toEqual(sqlite.snapshot);
    expect(memory.unflushedTelemetry).toEqual([]);
    expect(sqlite.unflushedTelemetry).toEqual([]);
  });

  it('replays an interrupted interpreter through both stores', () => {
    const path = 'fixtures/t04/restart-mid-interpretation.json';
    const memory = replayFixture(path, { store: 'memory' });
    const sqlite = replayFixture(path, { store: 'sqlite' });
    expect(memory.failures).toEqual([]);
    expect(sqlite.failures).toEqual([]);
    expect(memory.snapshot).toBeDefined();
    expect(sqlite.snapshot).toBeDefined();
    expect(memory.snapshot).toEqual(sqlite.snapshot);
    expect(memory.unflushedTelemetry).toEqual([]);
    expect(sqlite.unflushedTelemetry).toEqual([]);
    expect(memory.snapshot?.state.domain.interruptedCalls[0]?.status).toBe('interrupted');
  });

  it('replays the timer split through both stores', () => {
    const path = 'fixtures/t04/restart-timer-split.json';
    const memory = replayFixture(path, { store: 'memory' });
    const sqlite = replayFixture(path, { store: 'sqlite' });
    expect(memory.failures).toEqual([]);
    expect(sqlite.failures).toEqual([]);
    expect(memory.snapshot).toBeDefined();
    expect(sqlite.snapshot).toBeDefined();
    expect(memory.snapshot).toEqual(sqlite.snapshot);
    expect(memory.unflushedTelemetry).toEqual([]);
    expect(sqlite.unflushedTelemetry).toEqual([]);
    expect(memory.snapshot?.state.domain.timers).toHaveLength(6);
  });

  it('replays a crash after commit through both stores', () => {
    const path = 'fixtures/t04/crash-after-commit.json';
    const memory = replayFixture(path, { store: 'memory' });
    const sqlite = replayFixture(path, { store: 'sqlite' });
    expect(memory.failures).toEqual([]);
    expect(sqlite.failures).toEqual([]);
    expect(memory.snapshot).toBeDefined();
    expect(sqlite.snapshot).toBeDefined();
    expect(memory.snapshot).toEqual(sqlite.snapshot);
    expect(memory.unflushedTelemetry).toEqual([]);
    expect(sqlite.unflushedTelemetry).toEqual([]);
    expect(memory.snapshot?.state.domain.interruptedCalls[0]?.status).toBe('interrupted');
  });

  // The 5,001-event redelivery fixture replays through both memory and SQLite stores.
  it('replays a redelivery beyond the dedupe window through both stores', () => {
    const path = 'fixtures/t04/redelivery-beyond-window.json';
    const memory = replayFixture(path, { store: 'memory' });
    const sqlite = replayFixture(path, { store: 'sqlite' });
    expect(memory.failures).toEqual([]);
    expect(sqlite.failures).toEqual([]);
    expect(memory.snapshot).toBeDefined();
    expect(sqlite.snapshot).toBeDefined();
    expect(memory.snapshot).toEqual(sqlite.snapshot);
    expect(memory.unflushedTelemetry).toEqual([]);
    expect(sqlite.unflushedTelemetry).toEqual([]);
    expect(memory.snapshot?.state.meta.eventIds).not.toContain('generated-0');
  }, 120000);

  it('replays the reconnection floor gap through both stores', () => {
    const path = 'fixtures/t04/reconnect-floor-gap.json';
    const memory = replayFixture(path, { store: 'memory' });
    const sqlite = replayFixture(path, { store: 'sqlite' });
    expect(memory.failures).toEqual([]);
    expect(sqlite.failures).toEqual([]);
    expect(memory.snapshot).toBeDefined();
    expect(sqlite.snapshot).toBeDefined();
    expect(memory.snapshot).toEqual(sqlite.snapshot);
    expect(memory.unflushedTelemetry).toEqual([]);
    expect(sqlite.unflushedTelemetry).toEqual([]);
  });
});
