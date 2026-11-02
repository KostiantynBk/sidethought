import type { Config } from '../config/index.js';
import type { ReplyGeneration } from '../contract/index.js';
import type { Context } from './state.js';
import { startReplyTimers } from './reply-timers.js';
import { clearCommitOffsetOwner } from './contributions/delivery.js';

export function uninterpretedIds(context: Context): string[] {
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

function generation(context: Context, retry?: ReplyGeneration): ReplyGeneration {
  const priorInputs = new Set(context.domain.reply?.inputIds ?? []);
  const last = context.domain.inputs.findLastIndex(input => priorInputs.has(input.id));
  const inputIds = retry?.inputIds ?? context.domain.inputs.slice(last + 1)
    .filter(input => (input.origin ?? 'user') === 'user').map(input => input.id);
  return {
    requestId: retry?.requestId ?? context.id(),
    callId: context.id(),
    attempt: retry ? retry.attempt + 1 : 1,
    inputIds,
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

export function startReply(context: Context, at: number, config: Config, retry?: ReplyGeneration): void {
  clearReplyWait(context);
  // A new reply owns the next commit offset; an older interrupted remark must never take it.
  clearCommitOffsetOwner(context);
  const reply = generation(context, retry);
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
  startReplyTimers(context, at, config);
}
