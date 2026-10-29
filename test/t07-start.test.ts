import { expect, it } from 'vitest';
import { initialState, type Context } from '../src/kernel/index.js';
import { replyTimer, resumeReplyWait } from '../src/kernel/reply.js';
import { config } from './t03-helpers.js';
import { commit, committed, fire, interpreted } from './t07-helpers.js';

it('starts the Responder at debounce when interpretation has finished, with immutable captured versions', () => {
  const state = interpreted(committed()).state;
  state.domain.projectRev = 7;
  state.domain.items.r1 = {
    id: 'r1',
    kind: 'requirement',
    status: 'stated',
    text: 'Use local storage.',
    contentVersion: 3,
    private: false,
    provenance: {
      origin: 'user',
      quoteSpans: [],
    },
    voiceConfirmNeeded: false,
  };
  const result = fire(state, 'replyDebounce');
  const reply = result.state.domain.reply!;
  expect(result.effects).toEqual([{
    type: 'llm.call',
    role: 'responder',
    requestId: reply.requestId,
    callId: reply.callId,
    basisRev: 7,
    capturedInputs: [{
      itemId: 'r1',
      contentVersion: 3,
    }],
  }, {
    type: 'timer.set',
    timerId: 's.3.4',
    purpose: 'firstTokenTimeout',
    dueAt: 8800,
  }, {
    type: 'timer.set',
    timerId: 's.3.5',
    purpose: 'callDeadline',
    dueAt: 20800,
  }]);
  expect(reply.requestId).not.toBe(reply.callId);
  expect(reply.overridesSnapshotInputIds).toEqual([]);
  expect(result.state.domain.replyPending).toBe(true);
  state.domain.items.r1.contentVersion = 4;
  expect(reply.capturedInputs[0]?.contentVersion).toBe(3);
});

it('does not bypass the debounce when the Interpreter finishes early', () => {
  const result = interpreted(committed());
  expect(result.state.domain.reply).toBeNull();
  expect(result.effects.some(effect => effect.type === 'llm.call' && effect.role === 'responder')).toBe(false);
});

it('starts immediately when interpretation finishes within the soft-wait and clears its timer', () => {
  const waiting = fire(committed(), 'replyDebounce');
  expect(waiting.state.domain.reply).toBeNull();
  const timer = waiting.state.domain.timers.find(value => value.purpose === 'interpreterSoftWait')!;
  expect(timer.dueAt).toBe(config.replyDebounceMs + config.interpreterSoftWaitMs);
  const result = interpreted(waiting.state, 1000);
  expect(result.state.domain.reply?.overridesSnapshotInputIds).toEqual([]);
  expect(result.state.domain.replyStartWaiting).toBe(false);
  expect(result.effects).toContainEqual({
    type: 'timer.clear',
    timerId: timer.timerId,
  });
  expect(result.effects.filter(effect => effect.type === 'llm.call' && effect.role === 'responder')).toHaveLength(1);
});

it('records every still-uninterpreted user input at the cap, not only the Interpreter batch', () => {
  const first = committed();
  const next = commit(first, 1, 'second').state;
  const waiting = fire(next, 'replyDebounce').state;
  const result = fire(waiting, 'interpreterSoftWait');
  expect(result.state.domain.reply?.overridesSnapshotInputIds).toEqual(next.domain.inputs.map(input => input.id));
  expect(result.state.domain.reply?.inputIds).toEqual(next.domain.inputs.map(input => input.id));
  expect(result.state.domain.call?.inputIds).toHaveLength(1);
});

it('resets the soft-wait when another input starts a fresh debounce', () => {
  const waiting = fire(committed(), 'replyDebounce').state;
  const timer = waiting.domain.timers.find(value => value.purpose === 'interpreterSoftWait')!;
  const result = commit(waiting, 900, 'second');
  expect(result.state.domain.replyStartWaiting).toBe(false);
  expect(result.state.domain.timers.some(value => value.purpose === 'interpreterSoftWait')).toBe(false);
  expect(result.effects).toContainEqual({
    type: 'timer.clear',
    timerId: timer.timerId,
  });
  expect(result.state.domain.reply).toBeNull();
});

it('suppresses the reply when wait is interpreted before the Responder starts', () => {
  const waiting = fire(committed(), 'replyDebounce').state;
  const result = interpreted(waiting, 1000, 'wait');
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.state.domain.userWait).toBe(true);
  expect(result.state.domain.reply).toBeNull();
  expect(result.state.domain.replyStartWaiting).toBe(false);
  expect(result.state.domain.timers.some(timer => timer.purpose === 'interpreterSoftWait')).toBe(false);
  expect(result.effects.some(effect => effect.type === 'llm.call' && effect.role === 'responder')).toBe(false);
});

it('keeps a started reply and its reservation when the late interpretation says wait', () => {
  const waiting = fire(committed(), 'replyDebounce').state;
  const started = fire(waiting, 'interpreterSoftWait').state;
  const result = interpreted(started, 1500, 'wait');
  expect(result.state.domain.reply).toEqual(started.domain.reply);
  expect(result.state.domain.replyPending).toBe(true);
  expect(result.state.domain.userWait).toBe(true);
  expect(result.effects.some(effect => effect.type === 'llm.abort' || effect.type === 'llm.call')).toBe(false);
  expect(result.state.domain.timers.find(timer => timer.purpose === 'userWait')?.dueAt)
    .toBe(1500 + config.userWaitMs);
});

it('offers a no-cap hook for later Hold integration without starting while input is uninterpreted', () => {
  const state = committed();
  let id = 0;
  const context: Context = {
    config: state.config,
    domain: state.domain,
    effects: [],
    itemDecisions: [],
    id: () => `s.2.${++id}`,
  };
  expect(replyTimer(context, 'replyDebounce', 800, config, false)).toBe('reply:waiting_interpreter');
  expect(context.effects).toEqual([]);
  expect(context.domain.replyStartWaiting).toBe(true);
  context.domain.inputs[0]!.status = 'interpreted';
  resumeReplyWait(context, 900, config);
  expect(context.domain.reply?.status).toBe('streaming');
});

it('does not start a reply without an owed reservation', () => {
  const state = initialState('s', config);
  state.domain.timers.push({
    timerId: 'stale-debounce',
    purpose: 'replyDebounce',
    dueAt: 800,
  });
  const result = fire(state, 'replyDebounce');
  expect(result.effects).toEqual([]);
  expect(result.decisions[0]?.reason).toBe('reply:not_pending');
});
