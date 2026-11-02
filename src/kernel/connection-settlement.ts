import type { Context } from './state.js';
import { interruptReply, recordPrefix } from './reply-abort.js';
import { stopContribution } from './contributions/delivery.js';

// A lost client cannot acknowledge an open delivery. Preserve only sent text for the
// possibly-delivered snapshot; the interrupted prefix remains the sole model context (I9, I13).
export function settleConnectionDeliveries(context: Context): void {
  interruptReply(context, undefined, true);
  for (const candidate of Object.values(context.domain.initiative.candidates)) {
    if (candidate.state === 'delivering') stopContribution(context, candidate, 'disconnected', undefined, true);
  }
  // Old snapshots can contain more than one orphaned open delivery.
  for (const delivery of Object.values(context.domain.deliveries)) {
    if (delivery.finalAcknowledged || delivery.settled
      || !['delivering', 'interrupted'].includes(delivery.state)) continue;
    recordPrefix(delivery, undefined, true);
  }
}
