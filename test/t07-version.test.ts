import { expect, it } from 'vitest';
import { initialState } from '../src/kernel/index.js';
import { REDUCER_VERSION, ReducerVersionMismatchError, SessionRunner } from '../src/runtime/session-runner.js';
import { MemoryStore, type Snapshot } from '../src/store/index.js';
import { config } from './t03-helpers.js';

it('refuses a reducer v3 snapshot without A1 reply and delivery state', () => {
  expect(REDUCER_VERSION).toBe('5');
  const state = initialState('s', config);
  const { reply, deliveries, replyStartWaiting, ...oldDomain } = state.domain;
  const store = new MemoryStore();
  store.commit('s', [], {
    seq: 0,
    reducerVersion: '3',
    state: {
      ...state,
      domain: oldDomain,
    },
  } as unknown as Snapshot);
  const effects: unknown[] = [];
  const runner = new SessionRunner('s', config, store, () => 0, emitted => effects.push(...emitted));
  expect(() => runner.recover('recover')).toThrow(ReducerVersionMismatchError);
  expect(store.readJournal('s')).toEqual([]);
  expect(store.loadSnapshot('s')?.reducerVersion).toBe('3');
  expect(effects).toEqual([]);
  store.close();
});

it('refuses a reducer v4 snapshot before reading missing A2 and composer fields', () => {
  const state = initialState('s', config);
  const { composerActive, ...oldDomain } = state.domain;
  const store = new MemoryStore();
  store.commit('s', [], {
    seq: 0,
    reducerVersion: '4',
    state: {
      ...state,
      domain: oldDomain,
    },
  } as unknown as Snapshot);
  const effects: unknown[] = [];
  const runner = new SessionRunner('s', config, store, () => 0, emitted => effects.push(...emitted));
  expect(() => runner.recover('recover')).toThrow(ReducerVersionMismatchError);
  expect(store.readJournal('s')).toEqual([]);
  expect(effects).toEqual([]);
  store.close();
});
