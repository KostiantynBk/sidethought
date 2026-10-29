import type { Delivery } from '../src/contract/index.js';

// Legacy authority tests now explicitly seed delivery evidence, not model-generated input text.
export function deliveredSeed(id: string, text: string): Delivery {
  return {
    id,
    callId: `${id}-call`,
    basisRev: 0,
    state: 'delivered',
    chunks: [{
      text,
      state: 'rendered',
      claimIds: [],
      sentenceFinished: true,
    }],
    deliveredChars: text.length,
    sentChars: text.length,
    finalAcknowledged: true,
    doneSent: true,
    aborted: false,
    claimsDelivered: [],
  };
}
