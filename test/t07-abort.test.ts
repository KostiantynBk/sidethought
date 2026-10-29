import { expect, it } from 'vitest';
import { invariantRegistry } from '../src/harness/index.js';
import { wholeWordPrefix } from '../src/kernel/reply-abort.js';
import { parse } from './t03-helpers.js';
import { interrupt, sent } from './t07-abort-helpers.js';
import { replyResult } from './t07-helpers.js';

it('aborts and stops the client before scheduling any new model work on a commit', () => {
  const state = sent();
  const result = interrupt(state, 10);
  expect(result.effects.slice(0, 3)).toEqual([
    {
      type: 'llm.abort',
      callId: state.domain.reply!.callId,
    },
    {
      type: 'audio.stop',
      deliveryId: state.domain.reply!.deliveryId,
    },
    {
      type: 'client.send',
      message: {
        type: 'assistant.stopped',
        deliveryId: state.domain.reply!.deliveryId,
        reason: 'interrupted',
      },
    },
  ]);
  expect(result.effects.findIndex(effect => effect.type === 'llm.call')).toBeGreaterThan(2);
  expect(result.state.domain.reply?.status).toBe('aborted');
  expect(result.state.domain.replyPending).toBe(true); // The newly committed input owns this reservation.
});

it('records the raw mid-number prefix but trims its model marker and excludes its claim', () => {
  const state = sent();
  const deliveryId = state.domain.reply!.deliveryId;
  state.domain.deliveries[deliveryId]!.chunks[0]!.claimIds = ['price'];
  const offset = 'Provider B costs $1'.length;
  const result = interrupt(state, offset);
  const delivery = result.state.domain.deliveries[deliveryId]!;
  expect(delivery.deliveredChars).toBe(offset);
  expect(delivery.chunks[0]?.text).toBe('Provider B costs $1');
  expect(delivery.interruptedPrefix).toBe('Provider B costs');
  expect(delivery.claimsDelivered).toEqual([]);
  expect(delivery.chunks[0]?.sentenceFinished).toBe(false);
  expect(result.state.domain.reply?.buffer).toBe('');
});

it('counts a complete sentence claim even if its trailing whitespace was not rendered', () => {
  const state = sent('First claim. Second claim. ');
  const id = state.domain.reply!.deliveryId;
  state.domain.deliveries[id]!.chunks[0]!.claimIds = ['first'];
  state.domain.deliveries[id]!.chunks[1]!.claimIds = ['second'];
  const result = interrupt(state, 'First claim.'.length);
  const delivery = result.state.domain.deliveries[id]!;
  expect(delivery.claimsDelivered).toEqual(['first']);
  expect(delivery.chunks[0]?.sentenceFinished).toBe(true);
  expect(delivery.chunks[1]?.text).toBe('');
  expect(delivery.chunks[1]?.state).toBe('discarded');
});

it('clamps an oversized client offset to text that was actually sent', () => {
  const state = sent();
  const id = state.domain.reply!.deliveryId;
  const result = interrupt(state, 10000);
  expect(result.state.domain.deliveries[id]?.deliveredChars).toBe(state.domain.deliveries[id]?.sentChars);
});

it('never decreases recorded deliveredChars when a smaller offset arrives', () => {
  const state = sent();
  const id = state.domain.reply!.deliveryId;
  state.domain.deliveries[id]!.deliveredChars = 10;
  const result = interrupt(state, 2);
  expect(result.state.domain.deliveries[id]?.deliveredChars).toBe(10);
});

it('keeps only last recorded rendering when a streaming commit omits renderedUpTo', () => {
  const state = sent();
  const id = state.domain.reply!.deliveryId;
  state.domain.deliveries[id]!.deliveredChars = 9;
  const result = interrupt(state);
  expect(result.state.domain.deliveries[id]?.deliveredChars).toBe(9);
  expect(result.state.domain.deliveries[id]?.chunks[0]?.text).toBe('Provider ');
  expect(result.state.domain.reply?.status).toBe('aborted');
});

it('does not infer any rendering from sent text when no client offset has been recorded', () => {
  const state = sent();
  const id = state.domain.reply!.deliveryId;
  const result = interrupt(state);
  expect(result.state.domain.deliveries[id]?.deliveredChars).toBe(0);
  expect(result.state.domain.deliveries[id]?.chunks[0]?.text).toBe('');
});

it('stops and trims an unacknowledged delivery after reply.done when the commit includes renderedUpTo', () => {
  const state = replyResult(sent(), 'reply.done').state;
  const id = state.domain.reply!.deliveryId;
  const result = interrupt(state, 10);
  expect(result.state.domain.reply?.status).toBe('done');
  expect(result.state.domain.deliveries[id]?.deliveredChars).toBe(10);
  expect(result.state.domain.deliveries[id]?.aborted).toBe(true);
  expect(result.effects.some(effect => effect.type === 'audio.stop')).toBe(true);
  expect(result.effects.some(effect => effect.type === 'llm.abort')).toBe(false);
  expect(replyResult(result.state, 'reply.done').state.domain.replyPending).toBe(true);
});

it('leaves a completed delivery untouched when a commit omits renderedUpTo', () => {
  const state = replyResult(sent(), 'reply.done').state;
  const result = interrupt(state);
  expect(result.state.domain.deliveries).toEqual(state.domain.deliveries);
  expect(result.state.domain.reply).toEqual(state.domain.reply);
  expect(result.effects.some(effect => effect.type === 'audio.stop' || effect.type === 'llm.abort')).toBe(false);
});

it('does not apply renderedUpTo to a finally acknowledged delivery', () => {
  const state = replyResult(sent(), 'reply.done').state;
  state.domain.deliveries[state.domain.reply!.deliveryId]!.finalAcknowledged = true;
  const result = interrupt(state, 0);
  expect(result.state.domain.deliveries).toEqual(state.domain.deliveries);
});

it('keeps a whole word when rendering stops exactly at its boundary', () => {
  expect(wholeWordPrefix('A complete word next', 'A complete word'.length)).toBe('A complete word');
});

it('rejects a late chunk after abort without changing domain or releasing output', () => {
  const state = interrupt(sent(), 10).state;
  const result = replyResult(state, 'reply.chunk', 'Late secret text. ');
  expect(result.state.domain).toEqual(state.domain);
  expect(result.effects).toEqual([]);
  expect(result.decisions[0]?.reason).toBe('late:retired_reply');
});

it('leaves the new input reservation owned when an aborted call reports done', () => {
  const state = interrupt(sent(), 10).state;
  const result = replyResult(state, 'reply.done');
  expect(result.state.domain).toEqual(state.domain);
  expect(result.state.domain.replyPending).toBe(true);
});

it('leaves the new input reservation owned when an aborted call reports failed', () => {
  const state = interrupt(sent(), 10).state;
  const result = replyResult(state, 'reply.failed');
  expect(result.state.domain).toEqual(state.domain);
  expect(result.effects).toEqual([]);
});

it('I3 independently detects an assistant chunk attributed to an aborted delivery', () => {
  const state = interrupt(sent(), 10).state;
  const event = parse({
    eventId: 'synthetic-late',
    sessionId: 's',
    acceptedAt: 3000,
    type: 'reply.chunk',
    payload: {
      requestId: state.domain.reply!.requestId,
      callId: state.domain.reply!.callId,
      text: 'Late.',
    },
  });
  const effects = [{
    type: 'client.send' as const,
    message: {
      type: 'assistant.chunk' as const,
      deliveryId: state.domain.reply!.deliveryId,
      chunkIdx: 1,
      text: 'Late.',
    },
  }];
  const failures = invariantRegistry.flatMap(check => check(state, event, state, effects, []));
  expect(failures).toContain('I3 chunk forwarded after generation abort');
});
