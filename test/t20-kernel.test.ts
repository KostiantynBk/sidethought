import { afterEach, expect, it } from 'vitest';
import { researchClaims, verifiedClaims } from '../src/kernel/contributions/candidates.js';
import { ContributionHarness } from './t12a-helpers.js';
import { readyOutput } from './t03-helpers.js';
import {
  checkingInsight,
  claimText,
  expectInvalid,
  expectNoInsightChunk,
  finishedResearch,
  nominateInsight,
  researchEvidence,
  researchOutput,
  researchUrl,
} from './t20-helpers.js';

let h: ContributionHarness;
afterEach(() => h?.store.close());

it('rejects an unknown finding citation without an inference candidate', () => {
  const setup = finishedResearch();
  h = setup.h;
  nominateInsight(h, setup.item, ['unknown']);
  expectInvalid(h);
});

it('rejects a stale finding citation without an inference candidate', () => {
  const setup = finishedResearch();
  h = setup.h;
  const text = 'Plan a desktop pilot instead.';
  h.send('input.committed', { clientMsgId: 'replace', text, modality: 'text' });
  const inputId = h.state.domain.call!.inputIds[0]!;
  const span = { inputId, start: 0, end: text.length, quote: text };
  h.interpret({
    ...readyOutput,
    inputKinds: [{ inputId, kind: 'correction' }],
    ops: [{
      op: 'supersede',
      itemId: setup.item,
      quoteSpans: [span],
      replacement: {
        kind: 'requirement',
        status: 'stated',
        text,
        quoteSpans: [span],
      },
    }],
  });
  h.passReply();
  expect(h.state.domain.findings[setup.finding.id]?.validity.state).toBe('stale');
  nominateInsight(h, setup.item, [setup.finding.id]);
  expectInvalid(h);
});

it('rejects a needs_recheck finding citation without an inference candidate', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.send('item.action', {
    itemId: setup.item,
    expectedVersion: 1,
    action: 'edit',
    text: 'Plan a larger pilot on this laptop.',
  });
  expect(h.state.domain.findings[setup.finding.id]?.validity.state).toBe('needs_recheck');
  nominateInsight(h, setup.item, [setup.finding.id]);
  expectInvalid(h);
});

it('rejects a not_researched finding citation without an inference candidate', () => {
  const setup = finishedResearch(researchOutput, {
    completedSearchCalls: 0,
    issuedQueries: [],
    results: [],
  });
  h = setup.h;
  expect(setup.finding.verdict).toBe('not_researched');
  nominateInsight(h, setup.item, [setup.finding.id]);
  expectInvalid(h);
});

it('rejects a finding with no quote-verified claim', () => {
  const setup = finishedResearch(researchOutput, {
    ...researchEvidence,
    results: [{ url: researchUrl, snippet: 'Unrelated page text.' }],
  });
  h = setup.h;
  nominateInsight(h, setup.item, [setup.finding.id]);
  expectInvalid(h);
});

it('rejects a finding whose claim is inconsistent with its quote', () => {
  const setup = finishedResearch({
    ...researchOutput,
    claims: [{
      text: 'LightGBM supports Linux ARM64',
      support: researchOutput.claims[0]!.support,
    }],
  });
  h = setup.h;
  nominateInsight(h, setup.item, [setup.finding.id]);
  expectInvalid(h);
});

it('researchClaims independently excludes inconsistent support even when marked quoteVerified', () => {
  const setup = finishedResearch();
  h = setup.h;
  const finding = structuredClone(setup.finding);
  finding.claims[0]!.text = 'LightGBM supports Linux ARM64';
  expect(finding.claims[0]!.support[0]!.quoteVerified).toBe(true);
  expect(researchClaims(finding)).toEqual([]);
});

it('accepts an inconclusive finding and supplies verified claims, verdict and caveats to the Checker', () => {
  const setup = finishedResearch({ ...researchOutput, verdict: 'inconclusive' });
  h = setup.h;
  const candidate = nominateInsight(h, setup.item, [setup.finding.id])!;
  expect(candidate.source.findingIds).toEqual([setup.finding.id]);
  expect(candidate.source.findingId).toBeUndefined();
  expect(verifiedClaims(setup.finding)).toEqual([]);
  const payload = checkingInsight(h);
  expect(payload).toMatchObject({
    type: 'inference',
    research: [{
      findingId: setup.finding.id,
      question: 'Does LightGBM support Windows ARM64?',
      verdict: 'inconclusive',
      caveats: researchOutput.caveats,
      claims: [{
        id: `${setup.finding.id}:claim:0`,
        text: claimText,
        quote: claimText,
        url: researchUrl,
      }],
    }],
  });
});

for (const store of ['memory', 'sqlite'] as const) {
  it(`delivers a research-backed depth-1 insight without another user turn (${store})`, () => {
    const setup = finishedResearch(researchOutput, researchEvidence, store);
    h = setup.h;
    h.check();
    h.acknowledge();
    h.timer('deliberationDebounce');
    expect(h.state.domain.initiative.deliberation?.causalDepth).toBe(1);
    const candidate = nominateInsight(h, setup.item, [setup.finding.id])!;
    expect(candidate.class).toBe('speak');
    const payload = checkingInsight(h);
    expect(payload).toHaveProperty('research');
    const utterance = `I checked: ${claimText}. So I'd try LightGBM for the pilot.`;
    h.check(utterance);
    h.acknowledge();
    h.acknowledge();
    expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('delivered');
    const delivery = h.state.domain.deliveries[h.state.domain.initiative.candidates[candidate.id]!.deliveryId!]!;
    expect(delivery.chunks.map(chunk => chunk.text).join('')).toBe(utterance);
    expect(h.state.domain.inputs.filter(input => (input.origin ?? 'user') === 'user')).toHaveLength(1);
    expect(h.state.domain.initiative.candidates[candidate.id]?.checkedClaims).toEqual([]);
  });
}

it('demotes a research-backed utterance that adds an unsupported word without sending a chunk', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.check();
  h.acknowledge();
  const candidate = nominateInsight(h, setup.item, [setup.finding.id])!;
  checkingInsight(h);
  h.check(`I checked: ${claimText}. So I'd try LightGBM quasarx for the pilot.`);
  expectNoInsightChunk(h, candidate.id);
});

it('keeps research URLs disallowed in an inference utterance', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.check();
  h.acknowledge();
  const candidate = nominateInsight(h, setup.item, [setup.finding.id])!;
  checkingInsight(h);
  h.check(`I checked: ${claimText}. So I'd try LightGBM: ${researchUrl}`);
  expectNoInsightChunk(h, candidate.id);
});

it('preserves the existing low-consequence card class for a research-backed insight', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.nominate([{
    kind: 'insight',
    topic: 'Low priority idea',
    insight: 'Try a small pilot.',
    depItemIds: [setup.item],
    findingIds: [setup.finding.id],
    scores: {
      consequence: 1,
      uncertainty: 0,
      answerable: false,
      urgency: 0,
      needsPrivateDetail: false,
    },
  }]);
  const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'inference')!;
  expect(candidate.class).toBe('card');
  expectNoInsightChunk(h, candidate.id);
});
