import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import { REDUCER_VERSION, ReducerVersionMismatchError, SessionRunner } from '../src/runtime/session-runner.js';
import { MemoryStore, type Snapshot } from '../src/store/index.js';

it('refuses a previous-version snapshot with array-shaped items', () => {
  expect(REDUCER_VERSION).toBe('10');
  const store = new MemoryStore();
  const state = initialState('s', loadConfig());
  const oldState = {
    ...state,
    domain: {
      ...state.domain,
      items: [],
    },
  };
  store.commit('s', [], {
    seq: 0,
    reducerVersion: '1',
    state: oldState,
  } as unknown as Snapshot);
  const runner = new SessionRunner('s', loadConfig(), store, () => 0, () => {});
  expect(() => runner.recover('recover')).toThrow(ReducerVersionMismatchError);
  expect(store.readJournal('s')).toEqual([]);
  store.close();
});


it('refuses a version 2 snapshot after T06 changes the persisted shape', () => {
  const store = new MemoryStore();
  const state = initialState('s', loadConfig());
  store.commit('s', [], {
    seq: 0,
    reducerVersion: '2',
    state,
  });
  const runner = new SessionRunner('s', loadConfig(), store, () => 0, () => {});
  expect(() => runner.recover('recover')).toThrow(ReducerVersionMismatchError);
  store.close();
});
