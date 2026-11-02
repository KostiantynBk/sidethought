import type { Delivery } from '../../contract/index.js';
import type { Context } from '../state.js';
import { verifiedClaims } from './candidates.js';
import { transition } from './common.js';
import type { Contribution } from './types.js';

export function closesPromise(delivery: Delivery): boolean {
  return ['evidence_rendered', 'evidence_uncertain', 'fixed_sent'].includes(delivery.promiseWitness ?? '');
}

// D3: exact complete claims may close on an earlier sentence. For a paraphrase or a
// multi-sentence claim, retain the conservative final-sentence attribution.
export function sentenceClaims(context: Context, candidate: Contribution, parts: string[]): string[][] {
  const finding = context.domain.findings[candidate.source.findingId ?? ''];
  const claims = finding ? verifiedClaims(finding) : [];
  const mapped = parts.map(() => [] as string[]);
  for (const id of candidate.checkedClaims ?? []) {
    const claim = claims.find(value => value.id === id);
    const exact = claim ? parts.findIndex(part => part.trim() === claim.text.trim()) : -1;
    mapped[exact < 0 ? parts.length - 1 : exact]!.push(id);
  }
  return mapped;
}

export function reconcilePromise(context: Context, candidate: Contribution, delivery: Delivery): void {
  if (candidate.payload === 'evidence') {
    if (delivery.claimsDelivered.length) delivery.promiseWitness = 'evidence_rendered';
    else if (delivery.settled) {
      delivery.promiseWitness = delivery.renderedOffsetKnown ? 'evidence_incomplete' : 'evidence_uncertain';
    } else delivery.promiseWitness = 'evidence_pending';
  } else if (candidate.payload === 'closure' && delivery.sentChars > 0) {
    // Fixed closures retain their once-only transmission policy; never re-speak them.
    delivery.promiseWitness = 'fixed_sent';
  }
  const job = candidate.jobId ? context.domain.jobs[candidate.jobId] : undefined;
  if (!job?.promised) return;
  if (delivery.promiseWitness === 'evidence_rendered') {
    for (const closure of Object.values(context.domain.initiative.candidates)) {
      if (closure.jobId !== job.id || closure.payload !== 'closure' || closure.state === 'dropped') continue;
      const sent = closure.deliveryId ? context.domain.deliveries[closure.deliveryId]?.sentChars : 0;
      // Never retract or repeat a transmitted fixed closure; only retire an unsent fallback.
      if (!sent) transition(context, closure, 'dropped', 'promise:evidence_rendered');
    }
  }
  const deliveries = Object.values(context.domain.deliveries).filter(value => {
    const owner = value.candidateId ? context.domain.initiative.candidates[value.candidateId] : undefined;
    return owner?.jobId === job.id;
  });
  job.closureCount = deliveries.filter(closesPromise).length;
}
