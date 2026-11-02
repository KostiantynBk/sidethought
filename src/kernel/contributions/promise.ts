import type { Delivery } from '../../contract/index.js';
import type { Context } from '../state.js';
import { verifiedClaims } from './candidates.js';
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
  const deliveries = Object.values(context.domain.deliveries).filter(value => {
    const owner = value.candidateId ? context.domain.initiative.candidates[value.candidateId] : undefined;
    return owner?.jobId === job.id;
  });
  job.closureCount = deliveries.filter(closesPromise).length;
}
