import type { State } from '../state.js';
import type { Contribution } from './types.js';
import { researchClaims, verifiedClaims } from './candidates.js';

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
  const research = candidate.payload === 'inference' ? (candidate.source.findingIds ?? []).flatMap(id => {
    const source = domain.findings[id];
    return source ? [{
      findingId: source.id,
      question: domain.jobs[source.jobId]?.question ?? '',
      verdict: source.verdict,
      caveats: source.caveats,
      claims: researchClaims(source).map(claim => ({
        id: claim.id,
        text: claim.text,
        quote: claim.support[0]!.quote!,
        url: claim.support[0]!.url,
      })),
    }] : [];
  }) : [];
  return {
    type: candidate.payload,
    ...(candidate.payload === 'evidence' ? {
      verdict: finding?.verdict,
      claims: finding ? verifiedClaims(finding) : [],
    } : {
      text: candidate.text,
      citedItems: items,
      ...(candidate.source.lessons?.length ? { lessons: candidate.source.lessons } : {}),
      ...(research.length ? { research } : {}),
    }),
  };
}
