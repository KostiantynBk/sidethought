import type { Config } from '../config/index.js';
import type { Context } from './state.js';
import { interruptReply } from './reply-abort.js';
import { startReply } from './reply-start.js';
import { clearReplyTimers, type ReplyDeadline } from './reply-timers.js';

export const REPLY_FAILURE_NOTICE = 'I could not finish that reply. Please try again.';
export const REPLY_INTERRUPTED_NOTICE = 'My reply was interrupted. Would you like me to continue?';

export function failReply(context: Context, at: number, config: Config, reason: string): string {
  const reply = context.domain.reply;
  if (!reply || reply.status !== 'streaming') return 'late:retired_reply';
  const hadDelta = reason !== 'empty_output' && reply.receivedToken === true;
  clearReplyTimers(context);
  interruptReply(context, undefined);
  reply.status = 'failed';
  // §12: only a silent attempt retries; an incomplete streamed answer never silently restarts.
  if (!hadDelta && reply.attempt === 1) {
    context.domain.replyPending = true;
    startReply(context, at, config, reply);
    return reason === 'empty_output' ? 'reply:empty_output' : 'reply:retry';
  }
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'transcript.appended',
      text: hadDelta ? REPLY_INTERRUPTED_NOTICE : REPLY_FAILURE_NOTICE,
    },
  });
  return `reply:failed:${reason}`;
}

export function replyDeadline(context: Context, purpose: ReplyDeadline, at: number, config: Config): string {
  return failReply(context, at, config, purpose);
}
