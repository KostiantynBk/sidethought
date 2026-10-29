import { expect, it } from 'vitest';
import { reduce } from '../src/kernel/index.js';
import { parse } from './t03-helpers.js';
import { fire, replyResult, streaming } from './t07-helpers.js';

it('arms first-token and absolute deadlines when the responder starts', () => {
  expect(streaming().domain.timers.map(timer => [timer.purpose, timer.dueAt])).toEqual([
    ['firstTokenTimeout', 8800],
    ['callDeadline', 20800],
  ]);
});

it('retries the first silent timeout with the same request and a fresh generation', () => {
  const before = streaming();
  const result = fire(before, 'firstTokenTimeout');
  expect(result.decisions[0]?.reason).toBe('reply:retry');
  expect(result.state.domain.reply?.requestId).toBe(before.domain.reply?.requestId);
  expect(result.state.domain.reply?.callId).not.toBe(before.domain.reply?.callId);
  expect(result.state.domain.reply?.attempt).toBe(2);
  expect(result.state.domain.replyPending).toBe(true);
  expect(result.effects).toContainEqual({
    type: 'llm.abort',
    callId: before.domain.reply!.callId,
  });
});

it('gives an honest notice and releases the owner after the second silent timeout', () => {
  const retried = fire(streaming(), 'firstTokenTimeout').state;
  const result = fire(retried, 'firstTokenTimeout');
  expect(result.decisions[0]?.reason).toBe('reply:failed:firstTokenTimeout');
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.state.domain.timers).toEqual([]);
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
  expect(result.effects).toContainEqual({
    type: 'client.send',
    message: {
      type: 'transcript.appended',
      text: 'I could not finish that reply. Please try again.',
    },
  });
});

it('retries an empty completion with the same request and succeeds on the fresh attempt', () => {
  const before = streaming();
  const retried = replyResult(before, 'reply.done');
  expect(retried.decisions[0]?.reason).toBe('reply:empty_output');
  expect(retried.state.domain.reply?.requestId).toBe(before.domain.reply?.requestId);
  expect(retried.state.domain.reply?.callId).not.toBe(before.domain.reply?.callId);
  expect(retried.state.domain.replyPending).toBe(true);
  const answered = replyResult(retried.state, 'reply.chunk', 'Finished.').state;
  const done = replyResult(answered, 'reply.done');
  expect(done.decisions[0]?.reason).toBe('reply:done');
  expect(done.state.domain.replyPending).toBe(false);
});

it('reports failure after a second whitespace-only completion instead of passing', () => {
  const first = replyResult(streaming(), 'reply.chunk', '  \n').state;
  const retried = replyResult(first, 'reply.done');
  expect(retried.decisions[0]?.reason).toBe('reply:empty_output');
  const second = replyResult(retried.state, 'reply.chunk', '\t ').state;
  const result = replyResult(second, 'reply.done');
  expect(result.decisions[0]?.reason).toBe('reply:failed:empty_output');
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.effects).toContainEqual({
    type: 'client.send',
    message: {
      type: 'transcript.appended',
      text: 'I could not finish that reply. Please try again.',
    },
  });
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
});

it('renews the stall deadline for every nonempty delta without extending the total deadline', () => {
  const first = replyResult(streaming(), 'reply.chunk', 'First').state;
  expect(first.domain.timers.some(timer => timer.purpose === 'firstTokenTimeout')).toBe(false);
  const total = first.domain.timers.find(timer => timer.purpose === 'callDeadline');
  const oldStall = first.domain.timers.find(timer => timer.purpose === 'streamStall')!;
  const second = replyResult(first, 'reply.chunk', ' sentence. ').state;
  expect(second.domain.timers.find(timer => timer.purpose === 'callDeadline')).toEqual(total);
  expect(second.domain.timers.find(timer => timer.purpose === 'streamStall')?.timerId).not.toBe(oldStall.timerId);
  const stale = reduce(second, parse({
    eventId: 'stale-stall',
    sessionId: 's',
    acceptedAt: oldStall.dueAt,
    type: 'timer.fired',
    payload: {
      timerId: oldStall.timerId,
      purpose: 'streamStall',
    },
  }));
  expect(stale.decisions[0]?.reason).toBe('stale:timer');
  expect(stale.state.domain).toEqual(second.domain);
});

it('abandons a stalled stream without retrying or exposing its unacknowledged text', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'First sentence. Unsent tail').state;
  const result = fire(partial, 'streamStall');
  const reply = result.state.domain.reply!;
  const delivery = result.state.domain.deliveries[reply.deliveryId]!;
  expect(result.decisions[0]?.reason).toBe('reply:failed:streamStall');
  expect(reply.buffer).toBe('');
  expect(delivery.interruptedPrefix).toBe('');
  expect(delivery.chunks.every(chunk => chunk.text === '')).toBe(true);
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
});

it('abandons a stream at its total deadline even after a delta arrived', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'Still thinking').state;
  const result = fire(partial, 'callDeadline');
  expect(result.decisions[0]?.reason).toBe('reply:failed:callDeadline');
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.state.domain.timers).toEqual([]);
});

it('ignores a retired attempt completing while its retry owns the reservation', () => {
  const before = streaming();
  const retry = fire(before, 'firstTokenTimeout').state;
  const result = reduce(retry, parse({
    eventId: 'late-first-done',
    sessionId: 's',
    acceptedAt: 9000,
    type: 'reply.done',
    payload: {
      requestId: before.domain.reply!.requestId,
      callId: before.domain.reply!.callId,
    },
  }));
  expect(result.decisions[0]?.reason).toBe('late:retired_reply');
  expect(result.state.domain).toEqual(retry.domain);
});

it('clears every deadline on a normal owner completion', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'Finished.').state;
  const result = replyResult(partial, 'reply.done');
  expect(result.state.domain.timers).toEqual([]);
  expect(result.effects.filter(effect => effect.type === 'timer.clear')).toHaveLength(2);
});
