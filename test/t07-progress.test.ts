import { expect, it } from 'vitest';
import { reduce, type State } from '../src/kernel/index.js';
import { ClientMessageSchema } from '../src/contract/index.js';
import { parse } from './t03-helpers.js';
import { replyResult, streaming } from './t07-helpers.js';
import { interrupt } from './t07-abort-helpers.js';

function progress(state: State, chars: number, chunkIdx = 0, final = false) {
  return reduce(state, parse({
    eventId: `progress-${state.meta.seq + 1}`,
    sessionId: 's',
    acceptedAt: 1900 + state.meta.seq,
    type: 'delivery.progress',
    payload: {
      deliveryId: state.domain.reply!.deliveryId,
      chunkIdx,
      chars,
      final,
      reason: 'rendered',
    },
  }));
}

function delivery(state: State) {
  return state.domain.deliveries[state.domain.reply!.deliveryId]!;
}

it('advances a partial cumulative receipt without marking its whole chunk rendered', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First sentence. Next sentence. ').state;
  const result = progress(state, 6);
  expect(delivery(result.state).deliveredChars).toBe(6);
  expect(delivery(result.state).chunks[0]?.state).toBe('sent');
});

it('marks completed chunks rendered and does not double-count cumulative receipts', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First. Second. ').state;
  const first = progress(state, 7).state;
  const second = progress(first, 15, 1).state;
  expect(delivery(second).deliveredChars).toBe(15);
  expect(delivery(second).chunks.map(chunk => chunk.state)).toEqual(['rendered', 'rendered']);
  expect(delivery(progress(second, 15, 1).state).deliveredChars).toBe(15);
});

it('ignores decreasing acknowledgements', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First. ').state;
  const result = progress(progress(state, 7).state, 3);
  expect(result.decisions[0]?.reason).toBe('delivery:decrease_ignored');
  expect(delivery(result.state).deliveredChars).toBe(7);
});

it('clamps over-reported UTF-16 offsets to sent text', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'Hello 😀. ').state;
  const result = progress(state, 999);
  expect(delivery(result.state).deliveredChars).toBe('Hello 😀. '.length);
});

it('rejects a receipt whose chunk index does not match its cumulative offset', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First. Second. ').state;
  const result = progress(state, 15, 0);
  expect(result.decisions[0]?.reason).toBe('delivery:invalid_offset');
  expect(delivery(result.state).deliveredChars).toBe(0);
});

it('counts claims only when their sentence finished, allowing unrendered trailing whitespace', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'Price is $12. ').state;
  delivery(state).chunks[0]!.claimIds = ['price'];
  const partial = progress(state, 11).state;
  expect(delivery(partial).claimsDelivered).toEqual([]);
  const complete = progress(partial, 13).state;
  expect(delivery(complete).claimsDelivered).toEqual(['price']);
});

it('sends assistant.done after its last chunk and settles only after the full final receipt', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'Finished.').state;
  const done = replyResult(state, 'reply.done');
  const messages = done.effects.filter(effect => effect.type === 'client.send').map(effect => effect.message);
  expect(messages.map(message => message.type)).toEqual(['assistant.chunk', 'assistant.done']);
  expect(ClientMessageSchema.parse(messages.at(-1))).toEqual({
    type: 'assistant.done',
    deliveryId: delivery(done.state).id,
    chunkCount: 1,
  });
  expect(delivery(done.state).finalAcknowledged).toBe(false);
  const result = progress(done.state, 9, 0, true);
  expect(result.decisions[0]?.reason).toBe('delivery:final');
  expect(delivery(result.state).finalAcknowledged).toBe(true);
  expect(delivery(result.state).state).toBe('delivered');
  expect(progress(result.state, 9, 0, true).decisions[0]?.reason).toBe('delivery:settled');
});

it('does not finalize before assistant.done or on a partial final receipt', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First. ').state;
  const early = progress(state, 7, 0, true);
  expect(early.decisions[0]?.reason).toBe('delivery:premature_final');
  expect(delivery(early.state).finalAcknowledged).toBe(false);
  const done = replyResult(state, 'reply.done').state;
  const partial = progress(done, 3, 0, true);
  expect(partial.decisions[0]?.reason).toBe('delivery:premature_final');
  expect(delivery(partial.state).finalAcknowledged).toBe(false);
});

it('keeps the acknowledged prefix on a timeout and excludes a cut-off amount', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'Price is $12. ').state;
  const ack = progress(state, 11).state;
  const failed = replyResult(ack, 'reply.failed').state;
  expect(delivery(failed).deliveredChars).toBe(11);
  expect(delivery(failed).interruptedPrefix).toBe('Price is');
  expect(delivery(failed).claimsDelivered).toEqual([]);
});

it('ignores delayed progress after commit settlement instead of resurrecting trimmed text', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First sentence. ').state;
  const stopped = interrupt(state, 5).state;
  const result = progress(stopped, 16);
  expect(result.decisions[0]?.reason).toBe('delivery:settled');
  expect(delivery(result.state).deliveredChars).toBe(5);
});

it('passes silently for a split sentinel with surrounding whitespace', () => {
  const first = replyResult(streaming(), 'reply.chunk', '  [PA').state;
  const second = replyResult(first, 'reply.chunk', 'SS]\n').state;
  const result = replyResult(second, 'reply.done');
  expect(result.decisions[0]?.reason).toBe('reply:pass');
  expect(result.state.domain.reply?.status).toBe('passed');
  expect(result.state.domain.replyPending).toBe(false);
  expect(delivery(result.state).chunks).toEqual([]);
  expect(delivery(result.state).doneSent).toBeUndefined();
  expect(result.effects.some(effect => effect.type === 'client.send')).toBe(false);
});

it('never sends a standalone sentinel following an already sent sentence', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First. [PASS]').state;
  const result = replyResult(state, 'reply.done');
  expect(delivery(result.state).chunks.map(chunk => chunk.text)).toEqual(['First. ']);
  expect(result.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(false);
});
