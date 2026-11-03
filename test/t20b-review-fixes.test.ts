import { afterEach, expect, it } from 'vitest';
import type { InvestigatorOutput, RetrievalEvidence } from '../src/contract/index.js';
import { sentencesSupported } from '../src/kernel/contributions/checking.js';
import { ContributionHarness, scores } from './t12a-helpers.js';
import { checkingInsight, nominateInsight } from './t20-helpers.js';

const appleClaim = 'Apple Silicon runs the benchmark';
const snapdragonClaim = 'Snapdragon Elite runs the benchmark';
const ownText = 'So I would try the pilot.';
const supportGroups = [appleClaim, snapdragonClaim].map(claim => `${ownText} ${claim}`);

let h: ContributionHarness | undefined;
afterEach(() => h?.store.close());

it('supports a single basis across the MAU and Free sentence boundary', () => {
  const utterance = 'Supabase Free includes 50,000 MAU. Free projects pause after a week.';
  expect(sentencesSupported(utterance, [utterance])).toBe(true);
});

it('rejects one sentence fusing names unique to two finding groups', () => {
  const utterance = 'Apple Silicon and Snapdragon Elite both run the benchmark.';
  // All names occur in the union: rejection must depend on separate support groups.
  expect(sentencesSupported(utterance, [supportGroups.join(' ')])).toBe(true);
  expect(sentencesSupported(utterance, supportGroups)).toBe(false);
});

it('supports two sentences when each rests on its own finding group', () => {
  expect(sentencesSupported(`${appleClaim}. ${snapdragonClaim}.`, supportGroups)).toBe(true);
});

it('rejects a sentence naming an option absent from every group', () => {
  expect(sentencesSupported('Nvidia Grace runs the benchmark.', supportGroups)).toBe(false);
});

it('requires the union check when appending a finding changes a terminal number quantity', () => {
  const a = 'Alpha supports 5 seats Alpha supports 5 seats Alpha 5';
  const b = 'Bravo handles billing Bravo handles billing Billing Guide';
  // Group A ends with a unitless 5; appending B changes that derived quantity to 5|bravo.
  expect(sentencesSupported('Alpha 5.', [`${ownText} ${a}`, `${ownText} ${b}`])).toBe(true);
  expect(sentencesSupported('Alpha 5.', [`${ownText} ${a} ${b}`])).toBe(false);
});

interface ResearchSource {
  claim: string;
  title?: string;
}

const benchmarkSources: ResearchSource[] = [appleClaim, snapdragonClaim].map(claim => ({ claim }));

function researchFixture(claim: string, index: number, title?: string) {
  const url = `https://benchmarks.example/platform-${index}`;
  const output: InvestigatorOutput = {
    verdict: 'supported',
    claims: [{
      text: claim,
      support: [{
        url,
        title,
        quote: claim,
        sourceKind: 'official',
      }],
    }],
    caveats: [],
  };
  const evidence: RetrievalEvidence = {
    completedSearchCalls: 1,
    issuedQueries: [claim],
    results: [{
      url,
      title,
      snippet: claim,
    }],
  };
  return { output, evidence };
}

function finishedTwoFindingResearch(
  itemText = 'Plan a small pilot on this laptop.',
  sources = benchmarkSources,
) {
  const harness = new ContributionHarness('memory', {}, []);
  h = harness;
  harness.connect();
  const item = harness.statement(itemText);
  harness.passReply();
  harness.nominate(sources.map(({ claim }, index) => ({
    kind: 'investigation' as const,
    topic: `Benchmark platform ${index}`,
    question: `Can I confirm that ${claim}?`,
    publicQuery: claim,
    depItemIds: [item],
    scores,
  })));
  const jobs = Object.values(harness.state.domain.jobs);
  expect(jobs).toHaveLength(2);
  expect(jobs.map(job => job.state)).toEqual(['running', 'running']);
  harness.at += 3000;
  for (const [index, { claim, title }] of sources.entries()) {
    const { output, evidence } = researchFixture(claim, index, title);
    harness.complete(jobs[index]!.id, output, evidence);
  }
  const findings = Object.values(harness.state.domain.findings);
  expect(findings).toHaveLength(2);
  expect(findings.map(finding => finding.validity.state)).toEqual(['current', 'current']);
  expect(findings.map(finding => finding.claims[0]!.support[0]!.quoteVerified)).toEqual([true, true]);
  return { harness, item, findingIds: findings.map(finding => finding.id) };
}

function deliverEvidence(harness: ContributionHarness): void {
  for (let index = 0; index < 2; index += 1) {
    const checking = () => Object.values(harness.state.domain.initiative.candidates)
      .some(candidate => candidate.state === 'checking');
    if (!checking() && harness.state.domain.timers.some(timer => timer.purpose === 'floorGap')) {
      harness.timer('floorGap');
    }
    if (!checking()) harness.timer('rateLimit');
    harness.check();
    harness.acknowledge();
  }
  const evidence = Object.values(harness.state.domain.initiative.candidates)
    .filter(candidate => candidate.payload === 'evidence');
  expect(evidence.map(candidate => candidate.state)).toEqual(['delivered', 'delivered']);
}

function checkingTwoFindingInsight(itemText?: string, sources?: ResearchSource[]) {
  const { harness, item, findingIds } = finishedTwoFindingResearch(itemText, sources);
  deliverEvidence(harness);
  const candidate = nominateInsight(harness, item, findingIds, ownText)!;
  expect(candidate.source.findingIds).toEqual(findingIds);
  expect(checkingInsight(harness)).toMatchObject({
    type: 'inference',
    research: findingIds.map(findingId => ({ findingId })),
  });
  return { harness, candidate };
}

function decisionSince(harness: ContributionHarness, start: number, reason: string, candidateId?: string): boolean {
  const suffix = candidateId ? ` candidate=${candidateId}` : '';
  return harness.effects.slice(start).some(effect => effect.type === 'client.send'
    && effect.message.type === 'inspector.decision'
    && effect.message.reason === `contribution:${reason}${suffix}`);
}

it('demotes an insight whose finding join synthesizes an unsupported number-unit pair', () => {
  const sources = [
    { claim: 'requests remain bounded', title: 'Request Guide' },
    { claim: 'seats remain available', title: 'Seat Guide' },
  ];
  const { harness, candidate } = checkingTwoFindingInsight('Use a pilot size of 5.', sources);
  const payload = checkingInsight(harness);
  expect(payload).toMatchObject({
    text: ownText,
    citedItems: [{ text: 'Use a pilot size of 5.' }],
    research: sources.map(({ claim, title }) => ({ claims: [{ text: claim, quote: claim, title }] })),
  });
  const start = harness.effects.length;
  harness.check('So I would try 5 seats.');
  expect(harness.state.domain.initiative.candidates[candidate.id]?.state).toBe('card_only');
  expect(decisionSince(harness, start, 'check:payload_tokens', candidate.id)).toBe(true);
  expect(harness.state.domain.initiative.candidates[candidate.id]?.deliveryId).toBeUndefined();
  expect(harness.effects.slice(start).some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(false);
});

it('demotes a two-finding insight whose Checker fuses both names without sending any chunk', () => {
  const { harness, candidate } = checkingTwoFindingInsight();
  const start = harness.effects.length;
  harness.check('Apple Silicon and Snapdragon Elite both run the benchmark.');
  expect(harness.state.domain.initiative.candidates[candidate.id]).toMatchObject({ state: 'card_only' });
  expect(harness.state.domain.initiative.candidates[candidate.id]?.deliveryId).toBeUndefined();
  expect(decisionSince(harness, start, 'check:payload_tokens', candidate.id)).toBe(true);
  expect(harness.effects.slice(start).some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(false);
});

it('delivers a two-finding insight with one supported sentence per finding', () => {
  const { harness, candidate } = checkingTwoFindingInsight();
  const start = harness.effects.length;
  const utterance = `${appleClaim}. ${snapdragonClaim}.`;
  harness.check(utterance);
  expect(decisionSince(harness, start, 'check:passed', candidate.id)).toBe(true);
  expect(harness.state.domain.initiative.candidates[candidate.id]?.state).toBe('delivering');
  harness.acknowledge();
  harness.acknowledge();
  const delivered = harness.state.domain.initiative.candidates[candidate.id]!;
  expect(delivered.state).toBe('delivered');
  expect(delivered.checkedClaims).toEqual([]);
  const delivery = harness.state.domain.deliveries[delivered.deliveryId!]!;
  expect(delivery.chunks.map(chunk => chunk.text).join('')).toBe(utterance);
  const chunks = harness.effects.slice(start).flatMap(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk' ? [effect.message] : []);
  expect(chunks).toHaveLength(2);
  expect(chunks.every(chunk => chunk.deliveryId === delivered.deliveryId)).toBe(true);
});

function nominationHarness(): ContributionHarness {
  const harness = new ContributionHarness('memory', {}, []);
  h = harness;
  harness.connect();
  harness.statement('Plan a small pilot on this laptop.');
  harness.passReply();
  return harness;
}

it('drops an insight with only unknown dependencies without creating a candidate or job', () => {
  const harness = nominationHarness();
  const start = harness.effects.length;
  harness.nominate([{
    kind: 'insight',
    topic: 'Pilot next step',
    insight: ownText,
    depItemIds: ['unknown-item-a', 'unknown-item-b'],
    scores,
  }]);
  expect(Object.values(harness.state.domain.initiative.candidates)).toEqual([]);
  expect(Object.values(harness.state.domain.jobs)).toEqual([]);
  expect(decisionSince(harness, start, 'nomination:unknown_items')).toBe(true);
});

it('drops an investigation with only unknown dependencies without creating a candidate or job', () => {
  const harness = nominationHarness();
  const start = harness.effects.length;
  harness.nominate([{
    kind: 'investigation',
    topic: 'Benchmark support',
    question: 'Does Apple Silicon run the benchmark?',
    publicQuery: 'Apple Silicon benchmark',
    depItemIds: ['unknown-item-a', 'unknown-item-b'],
    scores,
  }]);
  expect(Object.values(harness.state.domain.initiative.candidates)).toEqual([]);
  expect(Object.values(harness.state.domain.jobs)).toEqual([]);
  expect(decisionSince(harness, start, 'nomination:unknown_items')).toBe(true);
});

it('accepts an insight whose dependency list was deliberately empty', () => {
  const harness = nominationHarness();
  const start = harness.effects.length;
  harness.nominate([{
    kind: 'insight',
    topic: 'Pilot next step',
    insight: ownText,
    depItemIds: [],
    scores,
  }]);
  const candidates = Object.values(harness.state.domain.initiative.candidates);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    payload: 'inference',
    text: ownText,
    deps: [],
  });
  expect(decisionSince(harness, start, 'nomination:unknown_items')).toBe(false);
});

it('accepts an investigation whose dependency list was deliberately empty', () => {
  const harness = nominationHarness();
  const start = harness.effects.length;
  harness.nominate([{
    kind: 'investigation',
    topic: 'Benchmark support',
    question: 'Does Apple Silicon run the benchmark?',
    publicQuery: 'Apple Silicon benchmark',
    depItemIds: [],
    scores,
  }]);
  const jobs = Object.values(harness.state.domain.jobs);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    state: 'running',
    origin: 'deliberator',
    deps: [],
    depItemIds: [],
  });
  expect(decisionSince(harness, start, 'nomination:unknown_items')).toBe(false);
});
