import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import { MemoryStore, SqliteStore, type SessionStore, type Snapshot } from '../src/store/index.js';
import { ReducerVersionMismatchError, SessionRunner } from '../src/runtime/session-runner.js';

function withStore(kind: 'memory' | 'sqlite', run: (store: SessionStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'sidethought-t04-'));
  const path = join(directory, 'test.sqlite');
  const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(path);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
}

function event(eventId: string, type: string, payload: object = {}) {
  return {
    eventId,
    sessionId: 's',
    type,
    payload,
  };
}

function input(eventId = 'input') {
  return event(eventId, 'input.committed', {
    clientMsgId: eventId,
    text: 'hello',
    modality: 'text',
  });
}

function runner(store: SessionStore, sink: ConstructorParameters<typeof SessionRunner>[4] = () => {}) {
  return new SessionRunner('s', loadConfig(), store, () => 100, sink);
}

describe.each(['memory', 'sqlite'] as const)('T04 %s store', kind => {
  it('recovers an interrupted interpreter without dispatching work', () => {
    withStore(kind, store => {
      const first = runner(store);
      first.accept(input());
      const sent: string[] = [];
      const recovered = runner(store, effects => sent.push(...effects.map(effect => effect.type)));
      const result = recovered.recover('recover');
      expect(result.state.domain.call).toBeNull();
      expect(result.state.domain.interruptedCalls[0]?.status).toBe('interrupted');
      expect(result.state.domain.inputs[0]?.status).toBe('needs_retry');
      expect(result.state.domain.replyPending).toBe(false);
      expect(sent).not.toContain('llm.call');
      expect(sent).not.toContain('job.dispatch');
    });
  });

  it('does not duplicate dispatch after a crash in the effect sink', () => {
    withStore(kind, store => {
      const first = runner(store, () => {
        throw new Error('simulated crash');
      });
      expect(() => first.accept(input())).toThrow('simulated crash');
      const effects: string[] = [];
      const recovered = runner(store, result => effects.push(...result.map(effect => effect.type)));
      recovered.recover('recover');
      expect(effects).not.toContain('llm.call');
      expect(recovered.accept(input()).decisions[0]?.reason).toBe('dup:eventId');
      expect(store.readJournal('s')).toHaveLength(2);
    });
  });

  it('loses unflushed telemetry but retains a durable event', () => {
    withStore(kind, store => {
      const first = runner(store);
      first.accept(input());
      first.accept(event('partial', 'voice.partial', { text: 'partial' }));
      expect(store.hasEventId('partial')).toBe(false);
      const recovered = runner(store);
      recovered.recover('recover');
      expect(store.hasEventId('input')).toBe(true);
      expect(store.hasEventId('partial')).toBe(false);
    });
  });

  it('flushes buffered telemetry with the next durable event', () => {
    withStore(kind, store => {
      const first = runner(store);
      first.accept(input());
      first.accept(event('partial', 'voice.partial', { text: 'partial' }));
      first.accept(event('durable', 'control.set', { action: 'hold' }));
      expect(store.readJournal('s').map(row => row.eventId)).toEqual(['input', 'partial', 'durable']);
      expect(store.loadSnapshot('s')?.seq).toBe(3);
    });
  });

  it('treats a duplicate detected during commit as a duplicate decision', () => {
    withStore(kind, store => {
      runner(store).accept(input());
      const original = store.hasEventId.bind(store);
      let firstCheck = true;
      store.hasEventId = eventId => {
        if (firstCheck) {
          firstCheck = false;
          return false;
        }
        return original(eventId);
      };
      const second = runner(store);
      const result = second.accept(input());
      expect(result.decisions[0]?.reason).toBe('dup:eventId');
      expect(result.effects).toEqual([]);
      expect(store.readJournal('s')).toHaveLength(1);
    });
  });

  it('buffers voice activity instead of committing it', () => {
    withStore(kind, store => {
      const first = runner(store);
      first.accept(event('ping', 'voice.activity', {
        turnId: 'turn',
        active: true,
      }));
      expect(store.hasEventId('ping')).toBe(false);
      expect(store.readJournal('s')).toEqual([]);
      expect(first.persistenceState().unflushed.map(item => item.eventId)).toEqual(['ping']);
    });
  });

  it('flushes buffered voice activity with a durable event', () => {
    withStore(kind, store => {
      const first = runner(store);
      first.accept(event('ping', 'voice.activity', {
        turnId: 'turn',
        active: true,
      }));
      first.accept(input());
      expect(store.readJournal('s').map(item => item.eventId)).toEqual(['ping', 'input']);
      expect(first.persistenceState().unflushed).toEqual([]);
    });
  });

  it('loses buffered voice activity on restart', () => {
    withStore(kind, store => {
      const first = runner(store);
      first.accept(input());
      first.accept(event('ping', 'voice.activity', {
        turnId: 'turn',
        active: true,
      }));
      runner(store).recover('recover');
      expect(store.hasEventId('input')).toBe(true);
      expect(store.hasEventId('ping')).toBe(false);
    });
  });

  it('rejects mismatched reducer versions with a typed error', () => {
    withStore(kind, store => {
      const state = initialState('s', loadConfig());
      store.commit('s', [], {
        seq: 0,
        reducerVersion: 'future',
        state,
      });
      expect(() => runner(store).recover('recover')).toThrow(ReducerVersionMismatchError);
    });
  });

  it('does not release effects when commit fails', () => {
    withStore(kind, store => {
      const sent: string[] = [];
      const original = store.commit.bind(store);
      store.commit = () => {
        throw new Error('commit failed');
      };
      expect(() => runner(store, effects => sent.push(...effects.map(effect => effect.type))).accept(input()))
        .toThrow('commit failed');
      expect(sent).toEqual([]);
      store.commit = original;
      expect(store.loadSnapshot('s')).toBeUndefined();
    });
  });

  it('releases effects only after the journal and snapshot are visible', () => {
    withStore(kind, store => {
      let checked = false;
      const first = runner(store, () => {
        expect(store.hasEventId('input')).toBe(true);
        expect(store.loadSnapshot('s')?.seq).toBe(1);
        checked = true;
      });
      first.accept(input());
      expect(checked).toBe(true);
    });
  });
});

describe('SQLite transaction and pragmas', () => {
  it('rolls back inserted journal rows if snapshot serialization fails', () => {
    withStore('sqlite', (store) => {
      const state = initialState('s', loadConfig());
      const circular = state as unknown as Record<string, unknown>;
      circular.loop = circular;
      const snapshot = {
        seq: 1,
        reducerVersion: '1',
        state,
      } as Snapshot;
      expect(() => store.commit('s', [{
        ...input(),
        type: 'input.committed',
        payload: {
          clientMsgId: 'input',
          text: 'hello',
          modality: 'text',
        },
        seq: 1,
        acceptedAt: 100,
      }], snapshot)).toThrow();
      expect(store.readJournal('s')).toEqual([]);
      expect(store.loadSnapshot('s')).toBeUndefined();
    });
  });

  it('enables WAL, secure deletion and foreign keys on a file database', () => {
    withStore('sqlite', store => {
      expect((store as SqliteStore).pragmas()).toEqual({
        journalMode: 'wal',
        secureDelete: 1,
        foreignKeys: 1,
      });
    });
  });
});
