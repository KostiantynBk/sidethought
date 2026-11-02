import { expect } from 'vitest';
import type { InvestigatorOutput, RetrievalEvidence } from '../src/contract/index.js';
import { candidatePayload } from '../src/kernel/contributions/payload.js';
import { ContributionHarness, scores } from './t12a-helpers.js';

export const claimText = 'LightGBM supports Windows ARM64 builds';
export const researchUrl = 'https://library.example/platform';
export const researchOutput: InvestigatorOutput = {
  verdict: 'supported',
  claims: [{
    text: claimText,
    support: [{
      url: researchUrl,
      quote: claimText,
      sourceKind: 'official',
    }],
  }],
  caveats: ['Package availability was not confirmed.'],
};
export const researchEvidence: RetrievalEvidence = {
  completedSearchCalls: 1,
  issuedQueries: ['LightGBM Windows ARM64'],
  results: [{
    url: researchUrl,
    snippet: claimText,
  }],
};
export const insightText = 'I checked the platform. So I would try LightGBM for the pilot.';

export function finishedResearch(
  output = researchOutput,
  evidence = researchEvidence,
  store: 'memory' | 'sqlite' = 'memory',
) {
  const h = new ContributionHarness(store, {}, []);
  h.connect();
  const item = h.statement('Plan a small pilot on this laptop.');
  h.passReply();
  h.nominate([{
    kind: 'investigation',
    topic: 'Platform support',
    question: 'Does LightGBM support Windows ARM64?',
    publicQuery: 'LightGBM Windows ARM64',
    depItemIds: [item],
    scores,
  }]);
  h.at += 3000;
  h.complete(undefined, output, evidence);
  return { h, item, finding: Object.values(h.state.domain.findings)[0]! };
}

export function nominateInsight(h: ContributionHarness, item: string, findingIds: string[], text = insightText) {
  h.nominate([{
    kind: 'insight',
    topic: 'Pilot next step',
    insight: text,
    depItemIds: [item],
    findingIds,
    scores,
  }]);
  return Object.values(h.state.domain.initiative.candidates).find(candidate => candidate.payload === 'inference');
}

export function checkingInsight(h: ContributionHarness) {
  const candidate = Object.values(h.state.domain.initiative.candidates)
    .find(value => value.payload === 'inference')!;
  if (candidate.state !== 'checking' && h.state.domain.timers.some(timer => timer.purpose === 'floorGap')) {
    h.timer('floorGap');
  }
  if (h.state.domain.initiative.candidates[candidate.id]?.state !== 'checking') h.timer('rateLimit');
  expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('checking');
  return candidatePayload(h.state.domain, h.state.domain.initiative.candidates[candidate.id]!);
}

export function expectInvalid(h: ContributionHarness) {
  expect(Object.values(h.state.domain.initiative.candidates).filter(c => c.payload === 'inference')).toEqual([]);
  expect(h.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'inspector.decision'
    && effect.message.reason === 'contribution:nomination:invalid_finding')).toBe(true);
}

export function expectNoInsightChunk(h: ContributionHarness, id: string) {
  const candidate = h.state.domain.initiative.candidates[id]!;
  expect(candidate.state).toBe('card_only');
  expect(candidate.deliveryId).toBeUndefined();
  expect(h.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk'
    && effect.message.deliveryId === candidate.deliveryId)).toBe(false);
}
