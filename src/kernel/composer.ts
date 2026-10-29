import type { Config } from '../config/index.js';
import type { Context } from './state.js';
import { clearReplyWait } from './reply.js';

export function clearComposer(context: Context, at: number, config: Config): void {
  const wasActive = context.domain.composerActive;
  context.domain.composerActive = false;
  if (!wasActive || !context.domain.replyPending || context.domain.reply?.status === 'streaming') return;
  // §8.1 / decision 10: becoming idle starts a full debounce, not an immediate reply.
  clearReplyWait(context);
  for (const timer of context.domain.timers.filter(timer => timer.purpose === 'replyDebounce')) {
    context.effects.push({
      type: 'timer.clear',
      timerId: timer.timerId,
    });
  }
  context.domain.timers = context.domain.timers.filter(timer => timer.purpose !== 'replyDebounce');
  const timer = {
    timerId: context.id(),
    purpose: 'replyDebounce' as const,
    dueAt: at + config.replyDebounceMs,
  };
  context.domain.timers.push(timer);
  context.effects.push({
    type: 'timer.set',
    ...timer,
  });
}
