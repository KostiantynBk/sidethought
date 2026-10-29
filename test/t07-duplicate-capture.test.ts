import { expect, it } from 'vitest';
import { assembleContext, type CallEffect } from '../src/context/index.js';
import { streaming } from './t07-helpers.js';

it('rejects two identical captures of an existing item at the correct version', () => {
  const state = streaming();
  state.domain.items['s.2.1'] = {
    id: 's.2.1',
    kind: 'requirement',
    status: 'stated',
    text: 'Use local storage.',
    contentVersion: 2,
    private: false,
    provenance: {
      origin: 'user',
      quoteSpans: [],
    },
    voiceConfirmNeeded: false,
  };
  const reply = state.domain.reply!;
  const effect: CallEffect = {
    type: 'llm.call',
    role: 'responder',
    requestId: reply.requestId,
    callId: reply.callId,
    basisRev: reply.basisRev,
    capturedInputs: [
      { itemId: 's.2.1', contentVersion: 2 },
      { itemId: 's.2.1', contentVersion: 2 },
    ],
  };
  expect(() => assembleContext(state, effect)).toThrow('context:capture_mismatch');
  effect.capturedInputs = [{ itemId: 's.2.1', contentVersion: 2 }];
  expect(() => assembleContext(state, effect)).not.toThrow();
});
