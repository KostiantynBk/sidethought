import type { Config } from '../config/index.js';
import type { KernelEvent, ReplyGeneration } from '../contract/index.js';
import type { Context } from './index.js';
import { bufferReplyDelta, finishReplyBuffer } from './reply-buffer.js';
import { releaseReplySentences } from './reply-output.js';

function uninterpretedIds(context: Context): string[] {
  return context.domain.inputs.filter(input =>
    (input.origin ?? 'user') === 'user' && input.status !== 'interpreted').map(input => input.id);
}

export function clearReplyWait(context: Context): void {
  context.domain.replyStartWaiting = false;
  for (const timer of context.domain.timers.filter(item => item.purpose === 'interpreterSoftWait')) {
    context.effects.push({
      type: 'timer.clear',
      timerId: timer.timerId,
    });
  }
  context.domain.timers = context.domain.timers.filter(item => item.purpose !== 'interpreterSoftWait');
}

function generation(context: Context): ReplyGeneration {
  return {
    requestId: context.id(),
    callId: context.id(),
    attempt: 1,
    inputIds: context.domain.inputs.filter(input => (input.origin ?? 'user') === 'user').map(input => input.id),
    basisRev: context.domain.projectRev,
    capturedInputs: Object.values(context.domain.items)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(item => ({
        itemId: item.id,
        contentVersion: item.contentVersion,
      })),
    deliveryId: context.id(),
    overridesSnapshotInputIds: uninterpretedIds(context),
    buffer: '',
    status: 'streaming',
  };
}

function startReply(context: Context): void {
  clearReplyWait(context);
  const reply = generation(context);
  context.domain.reply = reply;
  context.domain.deliveries[reply.deliveryId] = {
    id: reply.deliveryId,
    callId: reply.callId,
    basisRev: reply.basisRev,
    state: 'delivering',
    chunks: [],
    deliveredChars: 0,
    sentChars: 0,
    finalAcknowledged: false,
    aborted: false,
    claimsDelivered: [],
  };
  context.effects.push({
    type: 'llm.call',
    role: 'responder',
    requestId: reply.requestId,
    callId: reply.callId,
    basisRev: reply.basisRev,
    capturedInputs: reply.capturedInputs.map(dep => ({ ...dep })),
  });
}

// §8.1: interpretation completion can release the wait, but never bypass the debounce.
export function resumeReplyWait(context: Context): string | undefined {
  if (context.domain.composerActive && context.domain.replyPending) return 'reply:composer_active';
  if (!context.domain.replyStartWaiting) return;
  if (!context.domain.replyPending) {
    clearReplyWait(context);
  } else if (!uninterpretedIds(context).length) {
    startReply(context);
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
    startReply(context);
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

export function replyEvent(context: Context, event: ReplyEvent, config: Config): string {
  const reply = context.domain.reply;
  if (!reply || reply.status !== 'streaming' || reply.callId !== event.payload.callId
    || reply.requestId !== event.payload.requestId) return 'late:retired_reply';
  const delivery = context.domain.deliveries[reply.deliveryId]!;
  if (event.type === 'reply.chunk') {
    bufferReplyDelta(reply, delivery, event.payload.text);
    return releaseReplySentences(context, reply, delivery, config) ? 'reply:buffered' : 'reply:output_blocked';
  }
  finishReplyBuffer(reply, delivery, event.type === 'reply.failed');
  if (event.type === 'reply.done' && !releaseReplySentences(context, reply, delivery, config)) {
    return 'reply:output_blocked';
  }
  reply.status = event.type === 'reply.done' ? 'done' : 'failed';
  // §5.3: only this reservation's owning generation can release it.
  context.domain.replyPending = false;
  return event.type === 'reply.done' ? 'reply:done' : 'reply:failed';
}
