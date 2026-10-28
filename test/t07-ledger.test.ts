import { expect, it } from 'vitest';
import { DeliverySchema, ReplyGenerationSchema } from '../src/contract/index.js';
import { reduce } from '../src/kernel/index.js';
import { parse } from './t03-helpers.js';
import { replyResult, streaming } from './t07-helpers.js';

it('creates a valid empty delivery owned by the generation and bound to its basis', () => {
  const state = streaming();
  const reply = state.domain.reply!;
  expect(ReplyGenerationSchema.parse(reply)).toEqual(reply);
  const delivery = state.domain.deliveries[reply.deliveryId]!;
  expect(DeliverySchema.parse(delivery)).toEqual(delivery);
  expect(delivery).toEqual({
    id: reply.deliveryId,
    callId: reply.callId,
    basisRev: reply.basisRev,
    state: 'delivering',
    chunks: [],
    deliveredChars: 0,
    claimsDelivered: [],
  });
});

it('buffers split deltas into pending sentences without claiming delivery or sending unchecked text', () => {
  const state = streaming();
  const before = structuredClone(state);
  const partial = replyResult(state, 'reply.chunk', 'Local storage is').state;
  expect(partial.domain.deliveries[partial.domain.reply!.deliveryId]?.chunks).toEqual([]);
  const result = replyResult(partial, 'reply.chunk', ' fine. Next sentence');
  const reply = result.state.domain.reply!;
  const delivery = result.state.domain.deliveries[reply.deliveryId]!;
  expect(reply.buffer).toBe('Next sentence');
  expect(delivery.chunks).toEqual([{
    text: 'Local storage is fine. ',
    state: 'pending',
    claimIds: [],
    sentenceFinished: true,
  }]);
  expect(delivery.deliveredChars).toBe(0);
  expect(delivery.claimsDelivered).toEqual([]);
  expect(result.effects).toEqual([]);
  expect(state).toEqual(before);
});

it('buffers multiple sentences in order with their exact original text', () => {
  const result = replyResult(streaming(), 'reply.chunk', 'First! Second? Third. Tail');
  const reply = result.state.domain.reply!;
  const chunks = result.state.domain.deliveries[reply.deliveryId]!.chunks;
  expect(chunks.map(chunk => chunk.text)).toEqual(['First! ', 'Second? ', 'Third. ']);
  expect(reply.buffer).toBe('Tail');
});

it('does not split a decimal when the period is the last character of a delta', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'It costs 12.').state;
  const result = replyResult(partial, 'reply.chunk', '50 today. Next');
  const reply = result.state.domain.reply!;
  expect(result.state.domain.deliveries[reply.deliveryId]!.chunks.map(chunk => chunk.text))
    .toEqual(['It costs 12.50 today. ']);
});

it('flushes the final buffered sentence on owner done and clears only generation pending', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'Finished.').state;
  const result = replyResult(partial, 'reply.done');
  const reply = result.state.domain.reply!;
  const delivery = result.state.domain.deliveries[reply.deliveryId]!;
  expect(reply.status).toBe('done');
  expect(reply.buffer).toBe('');
  expect(result.state.domain.replyPending).toBe(false);
  expect(delivery.chunks[0]).toMatchObject({
    text: 'Finished.',
    state: 'pending',
    sentenceFinished: true,
  });
  expect(delivery.deliveredChars).toBe(0);
  expect(delivery.claimsDelivered).toEqual([]);
  expect(result.effects).toEqual([]);
});

it('discards pending sentences and the incomplete tail on owner failure', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'First. An unfinished').state;
  const result = replyResult(partial, 'reply.failed');
  const reply = result.state.domain.reply!;
  const delivery = result.state.domain.deliveries[reply.deliveryId]!;
  expect(result.state.domain.replyPending).toBe(false);
  expect(reply.status).toBe('failed');
  expect(reply.buffer).toBe('');
  expect(delivery.chunks.map(chunk => chunk.state)).toEqual(['discarded', 'discarded']);
  expect(delivery.chunks[1]?.sentenceFinished).toBe(false);
  expect(delivery.deliveredChars).toBe(0);
  expect(delivery.claimsDelivered).toEqual([]);
});

it('ignores a done event whose requestId does not belong to the current call', () => {
  const state = streaming();
  const result = reduce(state, parse({
    eventId: 'wrong-request',
    sessionId: 's',
    acceptedAt: 810,
    type: 'reply.done',
    payload: {
      requestId: 'foreign',
      callId: state.domain.reply!.callId,
    },
  }));
  expect(result.state.domain).toEqual(state.domain);
  expect(result.effects).toEqual([]);
  expect(result.decisions[0]?.reason).toBe('late:retired_reply');
});

it('ignores repeated terminal events after the owner has completed', () => {
  const completed = replyResult(streaming(), 'reply.done').state;
  const result = replyResult(completed, 'reply.failed');
  expect(result.state.domain).toEqual(completed.domain);
  expect(result.effects).toEqual([]);
  expect(result.decisions[0]?.reason).toBe('late:retired_reply');
});

it('invalidates the A1 owner on existing session recovery without auto-starting model work', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'First. Tail').state;
  const result = reduce(state, parse({
    eventId: 'recover',
    sessionId: 's',
    acceptedAt: 2000,
    type: 'session.recovered',
    payload: {},
  }));
  expect(result.state.domain.reply?.status).toBe('interrupted');
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.state.domain.reply?.buffer).toBe('');
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
});
