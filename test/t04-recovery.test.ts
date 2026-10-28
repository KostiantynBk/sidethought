import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { disconnectedFloorViolation } from '../src/harness/invariants.js';
import { initialState } from '../src/kernel/index.js';
import { REDUCER_VERSION, SessionRunner } from '../src/runtime/session-runner.js';
import { MemoryStore, SqliteStore, type SessionStore } from '../src/store/index.js';

const purposes = [
  'replyDebounce', 'interpreterSoftWait', 'firstTokenTimeout', 'streamStall', 'callDeadline',
  'floorGap', 'rateLimit', 'answerWait', 'userWait', 'candidateExpiry', 'checkTimeout',
  'deliberationDebounce', 'jobDeadline', 'waitExpiry', 'voiceGrace', 'deliveryAck',
] as const;
const rearmed = ['rateLimit', 'answerWait', 'userWait', 'candidateExpiry', 'waitExpiry', 'deliveryAck'];

type Kind = 'memory' | 'sqlite';
function execute(kind: Kind, scenario: (store: SessionStore) => unknown): unknown {
  const directory = mkdtempSync(join(tmpdir(), 'sidethought-recovery-'));
  const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(join(directory, 'test.sqlite'));
  try {
    return scenario(store);
  } finally {
    store.close();
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
}

function seedTimers(store: SessionStore): void {
  const state = initialState('s', loadConfig());
  state.domain.replyPending = true;
  state.domain.awaitingUserAnswer = true;
  state.domain.userWait = true;
  state.domain.clientConnected = true;
  state.domain.reservations = ['checking'];
  state.domain.timers = purposes.map(purpose => ({
    timerId: purpose,
    purpose,
    dueAt: 20000,
  }));
  store.commit('s', [], {
    seq: 0,
    reducerVersion: REDUCER_VERSION,
    state,
  });
}

function splitScenario(store: SessionStore) {
  seedTimers(store);
  const runner = new SessionRunner('s', loadConfig(), store, () => 100, () => {});
  const result = runner.recover('recover');
  expect(result.state.domain.timers.map(timer => timer.purpose)).toEqual(rearmed);
  expect(result.effects.map(effect => effect.type)).toEqual(rearmed.map(() => 'timer.set'));
  expect(result.state.domain).toMatchObject({
    clientConnected: false,
    replyPending: false,
    awaitingUserAnswer: false,
    userWait: false,
    reservations: [],
  });
  const fired = runner.accept({
    eventId: 'released-user-wait',
    sessionId: 's',
    type: 'timer.fired',
    payload: {
      timerId: 'userWait',
      purpose: 'userWait',
    },
  });
  expect(fired.decisions[0]?.reason).toBe('stale:timer');
  expect(fired.effects).toEqual([]);
  expect(fired.state.domain.timers.some(timer => timer.timerId === 'userWait')).toBe(false);
  return store.loadSnapshot('s');
}

function reconnectScenario(store: SessionStore) {
  seedTimers(store);
  let now = 100;
  const runner = new SessionRunner('s', loadConfig(), store, () => now, () => {});
  runner.recover('recover');
  expect(disconnectedFloorViolation(runner.current(), true)).toHaveLength(1);
  now = 10100;
  const result = runner.accept({
    eventId: 'connect',
    sessionId: 's',
    type: 'client.connected',
    payload: {
      modality: 'text',
    },
  });
  expect(result.state.domain.lastFloorActivity).toBe(now);
  expect(result.state.domain.timers.find(timer => timer.purpose === 'floorGap')?.dueAt).toBe(13100);
  expect(disconnectedFloorViolation(result.state, true)).toEqual([]);
  const disconnected = runner.accept({
    eventId: 'disconnect',
    sessionId: 's',
    type: 'client.disconnected',
    payload: {},
  });
  expect(disconnected.state.domain.clientConnected).toBe(false);
  expect(disconnectedFloorViolation(disconnected.state, true)).toHaveLength(1);
  return store.loadSnapshot('s');
}

function redeliveryScenario(store: SessionStore) {
  let now = 0;
  const runner = new SessionRunner('s', loadConfig(), store, () => ++now, () => {});
  const event = (id: string) => ({
    eventId: id,
    sessionId: 's',
    type: 'control.set',
    payload: {
      action: 'hold',
    },
  });
  for (let index = 0; index <= 5000; index++) runner.accept(event(`event-${index}`));
  const before = runner.current();
  expect(before.meta.eventIds).not.toContain('event-0');
  const duplicate = runner.accept(event('event-0'));
  expect(duplicate.decisions[0]?.reason).toBe('dup:eventId');
  expect(duplicate.effects).toEqual([]);
  expect(duplicate.state).toEqual(before);
  return store.loadSnapshot('s');
}

function interruptedScenario(store: SessionStore, crash: boolean) {
  const sink = () => {
    if (crash) throw new Error('crash after commit');
  };
  const first = new SessionRunner('s', loadConfig(), store, () => 100, sink);
  const input = {
    eventId: 'input',
    sessionId: 's',
    type: 'input.committed',
    payload: {
      clientMsgId: 'input',
      text: 'hello',
      modality: 'text',
    },
  };
  if (crash) expect(() => first.accept(input)).toThrow('crash after commit');
  else first.accept(input);
  const effects: string[] = [];
  const second = new SessionRunner('s', loadConfig(), store, () => 200, batch => {
    effects.push(...batch.map(effect => effect.type));
  });
  second.recover('recover');
  expect(second.current().domain.interruptedCalls[0]?.status).toBe('interrupted');
  expect(second.current().domain.inputs[0]?.status).toBe('needs_retry');
  expect(effects).not.toContain('llm.call');
  expect(effects).not.toContain('job.dispatch');
  return store.loadSnapshot('s');
}

describe('T04 identical store snapshots', () => {
  it('restart-mid-interpretation', () => {
    expect(execute('memory', store => interruptedScenario(store, false)))
      .toEqual(execute('sqlite', store => interruptedScenario(store, false)));
  });

  it('crash-after-commit', () => {
    expect(execute('memory', store => interruptedScenario(store, true)))
      .toEqual(execute('sqlite', store => interruptedScenario(store, true)));
  });
  it('restart-timer-split', () => {
    expect(execute('memory', splitScenario)).toEqual(execute('sqlite', splitScenario));
  });

  it('removes a fired timer even when its purpose mismatches', () => {
    const scenario = (store: SessionStore) => {
      seedTimers(store);
      const runner = new SessionRunner('s', loadConfig(), store, () => 100, () => {});
      runner.recover('recover');
      const before = runner.current();
      const result = runner.accept({
        eventId: 'mismatch',
        sessionId: 's',
        type: 'timer.fired',
        payload: {
          timerId: 'userWait',
          purpose: 'rateLimit',
        },
      });
      expect(result.decisions[0]?.reason).toBe('stale:timer');
      expect(result.effects).toEqual([]);
      expect(result.state.domain).toEqual({
        ...before.domain,
        timers: before.domain.timers.filter(timer => timer.timerId !== 'userWait'),
      });
      return store.loadSnapshot('s');
    };
    expect(execute('memory', scenario)).toEqual(execute('sqlite', scenario));
  });

  it('reconnect-floor-gap', () => {
    expect(execute('memory', reconnectScenario)).toEqual(execute('sqlite', reconnectScenario));
  });

  it('uses the voice gap for a voice reconnection', () => {
    const scenario = (store: SessionStore) => {
      const runner = new SessionRunner('s', loadConfig(), store, () => 100, () => {});
      const result = runner.accept({
        eventId: 'voice-connect',
        sessionId: 's',
        type: 'client.connected',
        payload: {
          modality: 'voice',
        },
      });
      expect(result.state.domain.timers[0]?.dueAt).toBe(1300);
      return store.loadSnapshot('s');
    };
    expect(execute('memory', scenario)).toEqual(execute('sqlite', scenario));
  });

  // 5,001 durable commits × 2 stores can be slow under full-suite load.
  it('redelivery-beyond-window', () => {
    expect(execute('memory', redeliveryScenario)).toEqual(execute('sqlite', redeliveryScenario));
  }, 120000);
});
