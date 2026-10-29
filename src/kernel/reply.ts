import type { Config } from '../config/index.js';
import type { KernelEvent } from '../contract/index.js';
import type { Context } from './index.js';
import { bufferReplyDelta, finishReplyBuffer } from './reply-buffer.js';
import { releaseReplySentences } from './reply-output.js';
import { clearReplyWait, startReply, uninterpretedIds } from './reply-start.js';
import { clearReplyTimers, receivedReplyDelta } from './reply-timers.js';
import { failReply } from './reply-failure.js';

export { clearReplyWait } from './reply-start.js';

// §8.1: interpretation completion can release the wait, but never bypass the debounce.
export function resumeReplyWait(context: Context, at: number, config: Config): string | undefined {
  if (context.domain.composerActive && context.domain.replyPending) return 'reply:composer_active';
  if (!context.domain.replyStartWaiting) return;
  if (!context.domain.replyPending) {
    clearReplyWait(context);
  } else if (!uninterpretedIds(context).length) {
    startReply(context, at, config);
  }
}

export function replyTimer(
  context: Context,
  purpose: 'replyDebounce' | 'interpreterSoftWait',
  at: number,
  config: Config,
  allowSoftWaitCap = true,
): string {
  if (!context.domain.replyPending) return 'reply:not_pending';
  if (context.domain.reply?.status === 'streaming') return 'reply:already_started';
  if (context.domain.composerActive) return 'reply:composer_active';
  // Hold integration hook (§5.6): its caller must disable the cap until interpretation finishes.
  if (!uninterpretedIds(context).length || (purpose === 'interpreterSoftWait' && allowSoftWaitCap)) {
    startReply(context, at, config);
    return 'reply:started';
  }
  context.domain.replyStartWaiting = true;
  if (allowSoftWaitCap) {
    const timer = {
      timerId: context.id(),
      purpose: 'interpreterSoftWait' as const,
      dueAt: at + config.interpreterSoftWaitMs,
    };
    context.domain.timers.push(timer);
    context.effects.push({
      type: 'timer.set',
      ...timer,
    });
  }
  return 'reply:waiting_interpreter';
}

type ReplyEvent = Extract<KernelEvent, { type: 'reply.chunk' | 'reply.done' | 'reply.failed' }>;

function finishReply(context: Context, at: number, config: Config): string {
  const reply = context.domain.reply!;
  const delivery = context.domain.deliveries[reply.deliveryId]!;
  if (!delivery.sentChars && !reply.buffer.trim()) return failReply(context, at, config, 'empty_output');
  clearReplyTimers(context);
  if (!delivery.sentChars && reply.buffer.trim() === '[PASS]') {
    reply.buffer = '';
    reply.status = 'passed';
    delivery.state = 'dropped';
    delivery.settled = true;
    context.domain.replyPending = false;
    return 'reply:pass';
  }
  finishReplyBuffer(reply, delivery, false);
  if (!releaseReplySentences(context, reply, delivery, config)) return 'reply:output_blocked';
  reply.status = 'done';
  context.domain.replyPending = false;
  if (delivery.sentChars) {
    delivery.doneSent = true;
    context.effects.push({
      type: 'client.send',
      message: {
        type: 'assistant.done',
        deliveryId: delivery.id,
        chunkCount: delivery.chunks.length,
      },
    });
  }
  return 'reply:done';
}

export function replyEvent(context: Context, event: ReplyEvent, config: Config): string {
  const reply = context.domain.reply;
  if (!reply || reply.status !== 'streaming' || reply.callId !== event.payload.callId
    || reply.requestId !== event.payload.requestId) return 'late:retired_reply';
  const delivery = context.domain.deliveries[reply.deliveryId]!;
  if (event.type === 'reply.chunk') {
    if (event.payload.text.length) {
      reply.receivedToken = true;
      receivedReplyDelta(context, event.acceptedAt!, config);
    }
    bufferReplyDelta(reply, delivery, event.payload.text);
    const released = releaseReplySentences(context, reply, delivery, config);
    if (!released) clearReplyTimers(context);
    return released ? 'reply:buffered' : 'reply:output_blocked';
  }
  if (event.type === 'reply.failed') return failReply(context, event.acceptedAt!, config, 'provider');
  return finishReply(context, event.acceptedAt!, config);
}
