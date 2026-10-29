import { expect, it } from 'vitest';
import { reduce, type State } from '../src/kernel/index.js';
import { config, parse } from './t03-helpers.js';
import { commit, committed, fire, interpreted, replyResult, streaming } from './t07-helpers.js';

function activity(state: State, active: boolean, at: number, channel = 'composer') {
  return reduce(state, parse({
    eventId: `activity-${state.meta.seq + 1}`,
    sessionId: 's',
    acceptedAt: at,
    type: 'input.activity',
    payload: {
      channel,
      active,
    },
  }));
}

function lifecycle(state: State, type: 'client.disconnected' | 'session.recovered', at: number) {
  return reduce(state, parse({
    eventId: `lifecycle-${state.meta.seq + 1}`,
    sessionId: 's',
    acceptedAt: at,
    type,
    payload: {},
  }));
}

it('activity before the debounce blocks start until idle plus a fresh full debounce', () => {
  const active = activity(interpreted(committed()).state, true, 700).state;
  const blocked = fire(active, 'replyDebounce');
  expect(blocked.decisions[0]?.reason).toBe('reply:composer_active');
  expect(blocked.effects).toEqual([]);
  expect(blocked.state.domain.reply).toBeNull();
  const idle = activity(blocked.state, false, 900).state;
  expect(idle.domain.timers.find(timer => timer.purpose === 'replyDebounce')?.dueAt).toBe(1700);
  expect(fire(idle, 'replyDebounce').state.domain.reply?.status).toBe('streaming');
});

it('activity during the soft-wait prevents cap start and restarts debounce then soft-wait on idle', () => {
  const waiting = fire(committed(), 'replyDebounce').state;
  const active = activity(waiting, true, 1000).state;
  const blocked = fire(active, 'interpreterSoftWait');
  expect(blocked.decisions[0]?.reason).toBe('reply:composer_active');
  expect(blocked.effects).toEqual([]);
  const idle = activity(blocked.state, false, 1500).state;
  expect(idle.domain.timers.find(timer => timer.purpose === 'replyDebounce')?.dueAt).toBe(2300);
  const debounced = fire(idle, 'replyDebounce').state;
  expect(debounced.domain.timers.find(timer => timer.purpose === 'interpreterSoftWait')?.dueAt).toBe(2900);
  expect(fire(debounced, 'interpreterSoftWait').state.domain.reply?.status).toBe('streaming');
});

it('interpretation completing while active cannot bypass the composer gate', () => {
  const waiting = fire(committed(), 'replyDebounce').state;
  const active = activity(waiting, true, 900).state;
  const completed = interpreted(active, 1000);
  expect(completed.decisions[0]?.reason).toBe('reply:composer_active');
  expect(completed.effects.some(effect => effect.type === 'llm.call')).toBe(false);
  expect(completed.state.domain.inputs[0]?.status).toBe('interpreted');
  const idle = activity(completed.state, false, 1100).state;
  expect(idle.domain.timers.some(timer => timer.purpose === 'interpreterSoftWait')).toBe(false);
  expect(idle.domain.timers.find(timer => timer.purpose === 'replyDebounce')?.dueAt).toBe(1900);
  expect(fire(idle, 'replyDebounce').state.domain.reply?.status).toBe('streaming');
});

it('commit clears composer activity and starts a new full debounce for the submitted draft', () => {
  const active = activity(interpreted(committed()).state, true, 700).state;
  const result = commit(active, 900, 'submitted');
  expect(result.state.domain.composerActive).toBe(false);
  expect(result.state.domain.timers.filter(timer => timer.purpose === 'replyDebounce')).toHaveLength(1);
  expect(result.state.domain.timers.find(timer => timer.purpose === 'replyDebounce')?.dueAt).toBe(1700);
});

it('disconnect clears composer activity and rearms a full debounce for the pending reply', () => {
  const active = activity(interpreted(committed()).state, true, 700).state;
  const result = lifecycle(active, 'client.disconnected', 900);
  expect(result.state.domain.composerActive).toBe(false);
  expect(result.state.domain.clientConnected).toBe(false);
  expect(result.state.domain.timers.find(timer => timer.purpose === 'replyDebounce')?.dueAt).toBe(1700);
  expect(fire(result.state, 'replyDebounce').state.domain.reply?.status).toBe('streaming');
});

it('recovery clears composer activity without restoring the reply reservation or model-work timers', () => {
  const active = activity(committed(), true, 700).state;
  const result = lifecycle(active, 'session.recovered', 900);
  expect(result.state.domain.composerActive).toBe(false);
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.state.domain.timers.some(timer => ['replyDebounce', 'interpreterSoftWait'].includes(timer.purpose)))
    .toBe(false);
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
});

it('composer activity during streaming neither aborts nor pauses sentence release', () => {
  const state = streaming();
  const active = activity(state, true, 900);
  expect(active.state.domain.reply).toEqual(state.domain.reply);
  expect(active.effects.some(effect => effect.type === 'llm.abort' || effect.type === 'audio.stop')).toBe(false);
  const delta = replyResult(active.state, 'reply.chunk', 'Still streaming. ');
  expect(delta.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'))
    .toBe(true);
  const idle = activity(delta.state, false, 1600);
  expect(idle.effects.some(effect => effect.type === 'timer.set')).toBe(false);
});

it('localVoice activity does not set the text composer gate', () => {
  const result = activity(interpreted(committed()).state, true, 700, 'localVoice');
  expect(result.state.domain.composerActive).toBe(false);
  expect(fire(result.state, 'replyDebounce').state.domain.reply?.status).toBe('streaming');
});

it('voice commits clear a stuck composer gate but retain the voice grace period', () => {
  const active = activity(committed(), true, 700).state;
  const result = reduce(active, parse({
    eventId: 'voice-commit',
    sessionId: 's',
    acceptedAt: 900,
    type: 'input.committed',
    payload: {
      clientMsgId: 'voice-commit',
      text: 'Continue.',
      modality: 'voice',
    },
  }));
  expect(result.state.domain.composerActive).toBe(false);
  expect(result.state.domain.timers.find(timer => timer.purpose === 'replyDebounce')?.dueAt)
    .toBe(900 + config.voiceGraceMs);
});

it('repeated idle activity does not perpetually postpone an already scheduled reply', () => {
  const state = interpreted(committed()).state;
  const result = activity(state, false, 700);
  expect(result.state.domain.timers).toEqual(state.domain.timers);
  expect(result.effects).toEqual([]);
});
