import type { Config } from '../config/index.js';
import type { Context, Timer } from './state.js';

export const REPLY_DEADLINES = ['firstTokenTimeout', 'streamStall', 'callDeadline'] as const;
export type ReplyDeadline = typeof REPLY_DEADLINES[number];

export function clearReplyTimers(context: Context, purposes: readonly string[] = REPLY_DEADLINES): void {
  for (const timer of context.domain.timers.filter(item => purposes.includes(item.purpose))) {
    context.effects.push({
      type: 'timer.clear',
      timerId: timer.timerId,
    });
  }
  context.domain.timers = context.domain.timers.filter(item => !purposes.includes(item.purpose));
}

function arm(context: Context, purpose: ReplyDeadline, dueAt: number): void {
  const timer: Timer = {
    timerId: context.id(),
    purpose,
    dueAt,
  };
  context.domain.timers.push(timer);
  context.effects.push({
    type: 'timer.set',
    ...timer,
  });
}

export function startReplyTimers(context: Context, at: number, config: Config): void {
  arm(context, 'firstTokenTimeout', at + config.firstTokenTimeoutMs);
  arm(context, 'callDeadline', at + config.callDeadlineMs);
}

export function receivedReplyDelta(context: Context, at: number, config: Config): void {
  clearReplyTimers(context, ['firstTokenTimeout', 'streamStall']);
  arm(context, 'streamStall', at + config.streamStallMs);
}
