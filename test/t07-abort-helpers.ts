import { reduce, type State } from '../src/kernel/index.js';
import { parse } from './t03-helpers.js';
import { replyResult, streaming } from './t07-helpers.js';

export function sent(text = 'Provider B costs $12 per month. '): State {
  return replyResult(streaming(), 'reply.chunk', text).state;
}

export function interrupt(state: State, renderedUpTo?: number) {
  return reduce(state, parse({
    eventId: `interrupt-${state.meta.seq + 1}`,
    sessionId: 's',
    acceptedAt: 2000,
    type: 'input.committed',
    payload: {
      clientMsgId: `message-${state.meta.seq + 1}`,
      text: 'Actually no cloud.',
      modality: 'text',
      ...(renderedUpTo === undefined ? {} : { renderedUpTo }),
    },
  }));
}
