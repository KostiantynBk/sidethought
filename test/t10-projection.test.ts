import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import type { Delivery, ReplyGeneration } from '../src/contract/index.js';
import { projectState } from '../src/server/projection.js';

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'delivery',
    callId: 'call',
    basisRev: 0,
    state: 'interrupted',
    chunks: [
      { text: 'Hello ', state: 'sent', claimIds: [], sentenceFinished: false },
      { text: 'world.', state: 'sent', claimIds: [], sentenceFinished: true },
    ],
    deliveredChars: 6,
    sentChars: 12,
    finalAcknowledged: false,
    aborted: true,
    claimsDelivered: [],
    ...overrides,
  };
}

function stateWithDelivery(value: Delivery) {
  const state = initialState('session', loadConfig());
  state.domain.deliveries[value.id] = value;
  return state;
}

describe('reconnect projection', () => {
  it('shows only the rendered prefix as transcript with interruption marker', () => {
    const result = projectState(stateWithDelivery(delivery()));
    expect(result.deliveries).toEqual([{ deliveryId: 'delivery', text: 'Hello ', interrupted: true }]);
  });

  it('includes sent chunks by index while a reply is streaming', () => {
    const state = stateWithDelivery(delivery({ state: 'delivering', aborted: false }));
    state.domain.reply = {
      requestId: 'request', callId: 'call', attempt: 1, inputIds: [], basisRev: 0,
      capturedInputs: [], deliveryId: 'delivery', overridesSnapshotInputIds: [], buffer: 'private',
      status: 'streaming',
    } satisfies ReplyGeneration;
    expect(projectState(state).streamingChunks).toEqual([
      { deliveryId: 'delivery', chunkIdx: 0, text: 'Hello ' },
      { deliveryId: 'delivery', chunkIdx: 1, text: 'world.' },
    ]);
  });

  it('keeps an unacknowledged finished remainder in a separate possibly-delivered card', () => {
    const result = projectState(stateWithDelivery(delivery()));
    expect(result.possiblyDelivered).toEqual([{ deliveryId: 'delivery', text: 'world.', interrupted: true }]);
    expect(result.streamingChunks).toEqual([]);
  });

  it('never exposes pending, discarded, or buffered text', () => {
    const value = delivery({
      chunks: [
        { text: 'shown', state: 'sent', claimIds: [], sentenceFinished: true },
        { text: 'pending-secret', state: 'pending', claimIds: [], sentenceFinished: false },
        { text: 'discarded-secret', state: 'discarded', claimIds: [], sentenceFinished: false },
      ],
      deliveredChars: 5,
      sentChars: 5,
    });
    const state = stateWithDelivery(value);
    state.domain.reply = {
      requestId: 'request', callId: 'call', attempt: 1, inputIds: [], basisRev: 0,
      capturedInputs: [], deliveryId: 'delivery', overridesSnapshotInputIds: [], buffer: 'buffer-secret',
      status: 'streaming',
    };
    const json = JSON.stringify(projectState(state));
    expect(json).not.toContain('pending-secret');
    expect(json).not.toContain('discarded-secret');
    expect(json).not.toContain('buffer-secret');
  });
});
