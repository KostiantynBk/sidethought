import { expect } from 'vitest';
import { ContributionHarness } from './t12a-helpers.js';

export const firstClaim = 'Edits work offline.';
export const secondClaim = 'Backups stay local.';
export const fixedClosure = "I couldn't verify that within this check — what I found is on the card";

export function startEvidence(kind: 'memory' | 'sqlite', multi = false, separateClaims = false) {
  const h = new ContributionHarness(kind);
  h.connect();
  h.request();
  h.passReply();
  h.at += 3000;
  const text = multi ? `${firstClaim} ${secondClaim}` : firstClaim;
  const url = 'https://example.com';
  const claims = (separateClaims ? [firstClaim, secondClaim] : [text]).map(value => ({
    text: value,
    support: [{ url, quote: value, sourceKind: 'official' as const }],
  }));
  h.complete(undefined, { verdict: 'supported', claims, caveats: [] }, {
    completedSearchCalls: 1,
    issuedQueries: ['offline edits'],
    results: [{ url, snippet: text }],
  });
  const checking = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'evidence')!;
  h.send('check.ready', {
    requestId: checking.check!.requestId,
    callId: checking.check!.callId,
    output: {
      applies: true,
      reason: 'Verified',
      utterance: text,
      claimsUsed: claims.map((_, index) => `${checking.source.findingId}:claim:${index}`),
    },
  });
  const candidate = h.state.domain.initiative.candidates[checking.id]!;
  expect(candidate.state).toBe('delivering');
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(0);
  const delivery = h.state.domain.deliveries[candidate.deliveryId!]!;
  expect(delivery.promiseWitness).toBe('evidence_pending');
  return { h, candidate, delivery };
}

export function interrupt(h: ContributionHarness, renderedUpTo?: number): void {
  h.send('input.committed', {
    clientMsgId: `thanks-${h.at}`,
    text: 'Thanks.',
    modality: 'text',
    ...(renderedUpTo === undefined ? {} : { renderedUpTo }),
  });
}

export function closureCandidates(h: ContributionHarness) {
  return Object.values(h.state.domain.initiative.candidates).filter(c => c.payload === 'closure');
}

export function finishFixedClosure(h: ContributionHarness, jobId: string): void {
  expect(h.state.domain.jobs[jobId]?.closureCount).toBe(0);
  h.interpret();
  h.passReply();
  for (let step = 0; step < 5 && closureCandidates(h)[0]?.state !== 'delivering'; step++) {
    const timer = h.state.domain.timers.find(t => ['floorGap', 'rateLimit'].includes(t.purpose));
    expect(timer).toBeDefined();
    h.timer(timer!.purpose);
  }
  expect(closureCandidates(h)).toHaveLength(1);
  expect(closureCandidates(h)[0]?.text).toBe(fixedClosure);
  expect(closureCandidates(h)[0]?.state).toBe('delivering');
  h.acknowledge();
  expect(closureCandidates(h)[0]?.state).toBe('delivered');
  expect(h.state.domain.jobs[jobId]?.closureCount).toBe(1);
  h.send('client.disconnected', {});
  h.connect();
  h.timer('floorGap');
  expect(h.effects.filter(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'
    && effect.message.text === fixedClosure)).toHaveLength(1);
}
