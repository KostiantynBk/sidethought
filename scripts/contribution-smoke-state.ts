import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import type { CallEffect } from '../src/context/index.js';

type Role = 'deliberator' | 'checker';

export function syntheticState(role: Role) {
  const state = initialState('synthetic-smoke', loadConfig());
  const effect: CallEffect = {
    type: 'llm.call',
    role,
    requestId: `smoke-${role}`,
    callId: `smoke-${role}-1`,
    basisRev: 0,
    capturedInputs: [{ itemId: 'item-1', contentVersion: 1 }],
  };
  state.domain.items['item-1'] = {
    id: 'item-1',
    kind: 'requirement',
    status: 'stated',
    text: 'Keep notes on the phone.',
    contentVersion: 1,
    private: false,
    provenance: { origin: 'user', quoteSpans: [] },
    voiceConfirmNeeded: false,
  };
  const owner = {
    requestId: effect.requestId,
    callId: effect.callId,
    basisRev: effect.basisRev,
    capturedInputs: effect.capturedInputs,
  };
  if (role === 'deliberator') {
    state.domain.initiative.deliberation = {
      ...owner,
      inputIds: ['input-1'],
      causalDepth: 0,
      deadlineTimerId: 'timer-1',
      deadlineAt: 30000,
    };
  } else {
    state.domain.initiative.candidates['candidate-1'] = {
      id: 'candidate-1',
      class: 'speak',
      payload: 'inference',
      state: 'checking',
      topic: 'notes',
      topicKey: 'notes',
      text: 'Keep notes on the phone.',
      source: {},
      inputDeps: effect.capturedInputs,
      deps: effect.capturedInputs,
      rebases: [],
      basisRev: 0,
      causalDepth: 0,
      promised: false,
      interruptions: 0,
      createdAt: 0,
      rechecks: 0,
      check: { ...owner, inputCount: 0, deadlineTimerId: 'timer-1' },
    };
  }
  return { state, effect };
}

