import { initialState, reduce, type State, type Timer } from '../src/kernel/index.js';
import { config, parse, readyOutput } from './t03-helpers.js';

export function commit(state: State, at = 0, id = 'commit') {
  return reduce(state, parse({
    eventId: id,
    sessionId: 's',
    acceptedAt: at,
    type: 'input.committed',
    payload: {
      clientMsgId: id,
      text: 'Use local storage.',
      modality: 'text',
    },
  }));
}

export function committed(): State {
  return commit(initialState('s', config)).state;
}

export function fire(state: State, purpose: Timer['purpose']) {
  const timer = state.domain.timers.find(value => value.purpose === purpose);
  if (!timer) throw new Error(`missing ${purpose}`);
  return reduce(state, parse({
    eventId: `fire-${timer.timerId}`,
    sessionId: 's',
    acceptedAt: timer.dueAt,
    type: 'timer.fired',
    payload: {
      timerId: timer.timerId,
      purpose,
    },
  }));
}

export function interpreted(state: State, at = 10, kind: 'statement' | 'wait' = 'statement') {
  const call = state.domain.call!;
  return reduce(state, parse({
    eventId: `ready-${call.callId}`,
    sessionId: 's',
    acceptedAt: at,
    type: 'interpretation.ready',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: call.inputIds.map(inputId => ({
          inputId,
          kind,
        })),
      },
    },
  }));
}

export function streaming(): State {
  return fire(interpreted(committed()).state, 'replyDebounce').state;
}

export function replyResult(state: State, type: 'reply.chunk' | 'reply.done' | 'reply.failed', text = '') {
  const reply = state.domain.reply!;
  return reduce(state, parse({
    eventId: `reply-${state.meta.seq + 1}`,
    sessionId: 's',
    acceptedAt: 1500 + state.meta.seq,
    type,
    payload: {
      requestId: reply.requestId,
      callId: reply.callId,
      ...(type === 'reply.chunk' ? { text } : {}),
      ...(type === 'reply.failed' ? { reason: 'scripted failure' } : {}),
    },
  }));
}
