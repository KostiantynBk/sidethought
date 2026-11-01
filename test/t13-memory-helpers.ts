import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState, type State } from '../src/kernel/index.js';
import type { CallEffect } from '../src/context/index.js';
import { REDUCER_VERSION } from '../src/runtime/session-runner.js';
import { SqliteStore } from '../src/store/sqlite.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export function memorySetup() {
  const dir = mkdtempSync(join(tmpdir(), 'sidethought-t13-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let store = new SqliteStore(join(dir, 'test.sqlite'));
  cleanups.push(() => store.close());
  const memory = store.projectMemory();
  const source = initialState('local', loadConfig());
  source.domain.inputs.push({
    id: 'local.1.1',
    text: 'Our amber-canary experiment took 43 minutes on this laptop; start with a small forecasting run.',
    status: 'interpreted',
  });
  source.domain.inputs.push({
    id: 'local.2.1',
    text: 'PRIVATE: unrelated source history must not be retrieved.',
    status: 'interpreted',
  });
  saveState(store, source);
  const target = memory.createProject('Forecast B');
  const lesson = memory.createLesson('local', {
    sourceInputId: 'local.1.1',
    quote: source.domain.inputs[0]!.text,
    text: 'The amber-canary run took 43 minutes; try a smaller first run on this laptop.',
    terms: ['forecasting'],
    confirmed: true,
  });
  function reopen() {
    store.close();
    store = new SqliteStore(join(dir, 'test.sqlite'));
    return { store, memory: store.projectMemory() };
  }
  return { dir, store, memory, source, target, lesson, reopen };
}

export function saveState(store: SqliteStore, state: State): void {
  store.commit(state.sessionId, [], {
    seq: state.meta.seq,
    reducerVersion: REDUCER_VERSION,
    state,
  });
}

export function modelState(projectId: string, text = 'I am starting a forecasting experiment.') {
  const state = initialState(projectId, loadConfig());
  state.domain.inputs.push({ id: `${projectId}.1.1`, text, status: 'interpreted' });
  const effect: CallEffect = {
    type: 'llm.call',
    role: 'responder',
    requestId: `${projectId}.3.1`,
    callId: `${projectId}.3.2`,
    basisRev: 0,
    capturedInputs: [],
  };
  state.domain.reply = {
    ...effect,
    attempt: 1,
    inputIds: [`${projectId}.1.1`],
    deliveryId: `${projectId}.3.3`,
    overridesSnapshotInputIds: [],
    buffer: '',
    status: 'streaming',
  };
  state.domain.call = {
    requestId: effect.requestId,
    callId: effect.callId,
    basisRev: 0,
    capturedInputs: [],
    attempt: 1,
    inputIds: [`${projectId}.1.1`],
    quoteWitness: { recent: [], sources: [] },
  };
  return { state, effect };
}
