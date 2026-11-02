import type { Delivery, KernelEvent } from '../contract/index.js';
import type { Context } from './state.js';

// Decision 17: cumulative UTF-16 offsets, never per-chunk increments.
function accountRendered(delivery: Delivery): void {
  let end = 0;
  const claims = new Set<string>();
  for (const chunk of delivery.chunks) {
    if (!['sent', 'rendered', 'played'].includes(chunk.state)) continue;
    const start = end;
    end += chunk.text.length;
    if (delivery.deliveredChars >= end) chunk.state = 'rendered';
    const sentenceEnd = start + chunk.text.trimEnd().length;
    if (chunk.sentenceFinished && delivery.deliveredChars >= sentenceEnd) {
      for (const claimId of chunk.claimIds) claims.add(claimId);
    }
  }
  delivery.claimsDelivered = [...claims];
}

export function deliveryProgress(
  context: Context,
  event: Extract<KernelEvent, { type: 'delivery.progress' }>,
): string {
  const { deliveryId, chunkIdx, chars, final } = event.payload;
  const delivery = context.domain.deliveries[deliveryId];
  if (!delivery) return 'delivery:unknown';
  if (delivery.finalAcknowledged || delivery.settled) return 'delivery:settled';
  const chunk = delivery.chunks[chunkIdx];
  if (!chunk || !['sent', 'rendered', 'played'].includes(chunk.state)) return 'delivery:invalid_chunk';
  const reported = Math.min(chars, delivery.sentChars);
  if (reported < delivery.deliveredChars) return 'delivery:decrease_ignored';
  const end = delivery.chunks.slice(0, chunkIdx + 1).reduce((sum, part) => sum + part.text.length, 0);
  const start = end - chunk.text.length;
  if (reported < start || reported > end) return 'delivery:invalid_offset';
  delivery.deliveredChars = reported;
  delivery.renderedOffsetKnown = true;
  accountRendered(delivery);
  if (!final) return 'delivery:progress';
  if (!delivery.doneSent || reported !== delivery.sentChars || chunkIdx !== delivery.chunks.length - 1) {
    return 'delivery:premature_final';
  }
  delivery.finalAcknowledged = true;
  delivery.state = 'delivered';
  return 'delivery:final';
}
