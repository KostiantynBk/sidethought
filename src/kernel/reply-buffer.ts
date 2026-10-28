import type { Delivery, ReplyGeneration } from '../contract/index.js';

function appendPending(delivery: Delivery, text: string): void {
  delivery.chunks.push({
    text,
    state: 'pending',
    claimIds: [],
    sentenceFinished: true,
  });
}

export function bufferReplyDelta(reply: ReplyGeneration, delivery: Delivery, delta: string): void {
  reply.buffer += delta;
  // §4.6: wait for a boundary, not just a delta. Lookahead avoids splitting a decimal
  // across deltas ("12." + "50"). End-of-stream is also a boundary, handled below.
  const boundaries = /[.!?]+["'”’)\]]*\s+/g;
  let consumed = 0;
  for (const match of reply.buffer.matchAll(boundaries)) {
    const end = match.index + match[0].length;
    appendPending(delivery, reply.buffer.slice(consumed, end));
    consumed = end;
  }
  reply.buffer = reply.buffer.slice(consumed);
  // A1 deliberately does not send: A2 must apply output checks before pending → sent.
}

export function finishReplyBuffer(reply: ReplyGeneration, delivery: Delivery, failed: boolean): void {
  if (failed) {
    for (const chunk of delivery.chunks) {
      if (chunk.state === 'pending') chunk.state = 'discarded';
    }
    if (reply.buffer) {
      delivery.chunks.push({
        text: reply.buffer,
        state: 'discarded',
        claimIds: [],
        sentenceFinished: false,
      });
    }
    delivery.state = 'interrupted';
  } else if (reply.buffer) {
    appendPending(delivery, reply.buffer);
  }
  reply.buffer = '';
}
