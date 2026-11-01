import type { State } from '../state.js';
import type { Contribution } from './types.js';
import { verifiedClaims } from './candidates.js';

export function candidatePayload(domain: State['domain'], candidate: Contribution) {
  const finding = candidate.source.findingId ? domain.findings[candidate.source.findingId] : undefined;
  const items = candidate.deps.flatMap(dep => {
    const item = domain.items[dep.itemId];
    return item ? [{
      id: item.id,
      contentVersion: item.contentVersion,
      status: item.status,
      text: item.text,
    }] : [];
  });
  return {
    type: candidate.payload,
    ...(candidate.payload === 'evidence' ? {
      verdict: finding?.verdict,
      claims: finding ? verifiedClaims(finding) : [],
    } : {
      text: candidate.text,
      citedItems: items,
    }),
  };
}
