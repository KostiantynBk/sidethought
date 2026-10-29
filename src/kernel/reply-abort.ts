import type { Delivery } from '../contract/index.js';
import type { Context } from './state.js';
import { clearReplyTimers } from './reply-timers.js';

export function wholeWordPrefix(sentText: string, count: number): string {
  const prefix = sentText.slice(0, count);
  if (count >= sentText.length || /\s/u.test(sentText[count] ?? '') || /\s$/u.test(prefix)) {
    return prefix.trimEnd();
  }
  return prefix.replace(/\S+$/u, '').trimEnd();
}

function recordPrefix(delivery: Delivery, renderedUpTo: number | undefined): void {
  const sentText = delivery.chunks.filter(chunk => ['sent', 'rendered', 'played'].includes(chunk.state))
    .map(chunk => chunk.text).join('');
  const reported = renderedUpTo === undefined ? delivery.deliveredChars : Math.min(renderedUpTo, delivery.sentChars);
  delivery.deliveredChars = Math.max(delivery.deliveredChars, reported);
  delivery.interruptedPrefix = wholeWordPrefix(sentText, delivery.deliveredChars);
  delivery.settled = true;
  let remaining = delivery.deliveredChars;
  const claims = new Set<string>();
  for (const chunk of delivery.chunks) {
    const sent = ['sent', 'rendered', 'played'].includes(chunk.state);
    const chars = sent ? Math.min(remaining, chunk.text.length) : 0;
    const finished = sent && chunk.sentenceFinished && chars >= chunk.text.trimEnd().length;
    if (finished) for (const claimId of chunk.claimIds) claims.add(claimId);
    chunk.text = chunk.text.slice(0, chars);
    chunk.state = chars ? 'rendered' : 'discarded';
    chunk.sentenceFinished = finished;
    if (!finished) chunk.claimIds = [];
    remaining -= chars;
  }
  delivery.claimsDelivered = [...claims];
  delivery.state = 'interrupted';
  delivery.aborted = true;
}

export function interruptReply(context: Context, renderedUpTo: number | undefined): void {
  const reply = context.domain.reply;
  const streaming = reply?.status === 'streaming';
  if (streaming) {
    reply.status = 'aborted';
    reply.buffer = '';
    context.effects.push({
      type: 'llm.abort',
      callId: reply.callId,
    });
    context.domain.replyPending = false;
  }
  // Decisions 7–8: a completed generation is not evidence that its text was rendered.
  const latest = Object.values(context.domain.deliveries).findLast(delivery => !delivery.finalAcknowledged);
  // Generation retirement is distinct from settlement of its client delivery.
  if (!latest || latest.settled || (!streaming && renderedUpTo === undefined)) {
    if (streaming) clearReplyTimers(context);
    return;
  }
  recordPrefix(latest, renderedUpTo);
  context.effects.push({
    type: 'audio.stop',
    deliveryId: latest.id,
  });
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'assistant.stopped',
      deliveryId: latest.id,
      reason: 'interrupted',
    },
  });
  if (streaming) clearReplyTimers(context);
}
