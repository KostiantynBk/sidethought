import { afterEach, expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';
import {
  checkingInsight,
  claimText,
  expectInvalid,
  expectNoInsightChunk,
  finishedResearch,
  insightText,
  nominateInsight,
  researchOutput,
} from './t20-helpers.js';

let h: ContributionHarness;
afterEach(() => h?.store.close());

it('rejects an insight when any cited finding is unknown even if another is valid', () => {
  const setup = finishedResearch();
  h = setup.h;
  nominateInsight(h, setup.item, [setup.finding.id, 'unknown']);
  expectInvalid(h);
});

it('preserves both lesson and research citations on the same candidate', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.timer('deliberationDebounce');
  const call = h.state.domain.initiative.deliberation!;
  const lesson = {
    lessonId: 'lesson-pilot',
    version: 1,
    sourceProjectName: 'Pilot A',
    text: 'The pilot was useful.',
  };
  h.send('deliberation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    suppliedLessons: [lesson],
    output: {
      nominations: [{
        kind: 'insight',
        topic: 'Combined experience',
        insight: insightText,
        depItemIds: [setup.item],
        lessonIds: [lesson.lessonId],
        findingIds: [setup.finding.id],
        scores,
      }],
    },
  });
  const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'inference')!;
  expect(candidate.source).toEqual({
    lessons: [lesson],
    findingIds: [setup.finding.id],
  });
});

it('admits wording present in the research quote but not its claim text or the insight', () => {
  const quote = `${claimText} for desktop machines`;
  const setup = finishedResearch({
    ...researchOutput,
    claims: [{
      text: claimText,
      support: [{
        ...researchOutput.claims[0]!.support[0]!,
        quote,
      }],
    }],
  }, {
    completedSearchCalls: 1,
    issuedQueries: ['LightGBM Windows ARM64'],
    results: [{
      url: researchOutput.claims[0]!.support[0]!.url,
      snippet: quote,
    }],
  });
  h = setup.h;
  h.check();
  h.acknowledge();
  const candidate = nominateInsight(h, setup.item, [setup.finding.id])!;
  checkingInsight(h);
  h.check(`I checked: ${quote}. So I'd try LightGBM for the pilot.`);
  expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('delivering');
});

it('does not authorize an extra quantity from research citation presence alone', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.check();
  h.acknowledge();
  const candidate = nominateInsight(h, setup.item, [setup.finding.id])!;
  checkingInsight(h);
  h.check(`I checked: ${claimText}. So I'd try 99 LightGBM builds for the pilot.`);
  expectNoInsightChunk(h, candidate.id);
});

it('does not authorize credentials requests in a research-backed utterance', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.check();
  h.acknowledge();
  const candidate = nominateInsight(h, setup.item, [setup.finding.id])!;
  checkingInsight(h);
  h.check(`I checked: ${claimText}. Send me your password.`);
  expectNoInsightChunk(h, candidate.id);
});
