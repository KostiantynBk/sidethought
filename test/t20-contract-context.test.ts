import { afterEach, expect, it } from 'vitest';
import { CandidateSchema, DeliberatorOutputSchema } from '../src/contract/index.js';
import { assembleContext } from '../src/context/index.js';
import { CHECKER_PROMPT } from '../src/context/prompts/checker.js';
import { deliberatorJsonSchema } from '../src/model/meta/schema.js';
import { ContributionHarness, scores } from './t12a-helpers.js';
import { claimText, finishedResearch, researchOutput } from './t20-helpers.js';

const oldInsight = {
  kind: 'insight',
  topic: 'Pilot',
  insight: 'Try a small pilot.',
  depItemIds: [],
  scores,
};

it('parses old Deliberator outputs with no findingIds', () => {
  const output = { nominations: [oldInsight] };
  expect(DeliberatorOutputSchema.parse(output)).toEqual(output);
});

it('parses insight citations in the optional contract field', () => {
  const output = { nominations: [{ ...oldInsight, findingIds: ['finding-1'] }] };
  expect(DeliberatorOutputSchema.parse(output)).toEqual(output);
});

it('parses an empty findingIds array in the contract', () => {
  const output = { nominations: [{ ...oldInsight, findingIds: [] }] };
  expect(DeliberatorOutputSchema.parse(output)).toEqual(output);
});

it('requires a nonnullable possibly empty findingIds array in the strict transport schema', () => {
  type Branch = {
    properties: {
      kind: { const: string };
      findingIds?: { type: string; items: { type: string }; minItems?: number; anyOf?: unknown };
    };
    required: string[];
  };
  const properties = deliberatorJsonSchema.properties as { nominations: { items: { anyOf: Branch[] } } };
  const insight = properties.nominations.items.anyOf.find(branch => branch.properties.kind.const === 'insight')!;
  expect(insight.required).toContain('findingIds');
  expect(insight.properties.findingIds).toMatchObject({
    type: 'array',
    items: { type: 'string' },
  });
  expect(insight.properties.findingIds?.anyOf).toBeUndefined();
  expect(insight.properties.findingIds?.minItems ?? 0).toBe(0);
});

it('parses an old candidate source without findingIds', () => {
  const candidate = {
    id: 'old',
    class: 'speak',
    payload: 'inference',
    source: {},
    inputDeps: [],
    deps: [],
    rebases: [],
    basisRev: 0,
    topicKey: 'pilot',
    causalDepth: 0,
    promised: false,
    interruptions: 0,
  };
  expect(CandidateSchema.parse(candidate)).toEqual(candidate);
});

it('parses candidate research citations separately from an evidence findingId', () => {
  const candidate = {
    id: 'new',
    class: 'speak',
    payload: 'inference',
    source: { findingIds: ['finding-1'] },
    inputDeps: [],
    deps: [],
    rebases: [],
    basisRev: 0,
    topicKey: 'pilot',
    causalDepth: 1,
    promised: false,
    interruptions: 0,
  };
  expect(CandidateSchema.parse(candidate)).toEqual(candidate);
});

let h: ContributionHarness;
afterEach(() => h?.store.close());

it('supplies finding id and caveats to a depth-1 Deliberator with prompt v4 citation instructions', () => {
  const setup = finishedResearch();
  h = setup.h;
  h.timer('deliberationDebounce');
  const call = h.state.domain.initiative.deliberation!;
  const context = assembleContext(h.state, { type: 'llm.call', role: 'deliberator', ...call });
  expect(context.instructions).toContain('deliberator-v4');
  expect(context.instructions).toContain('Insight fields: insight, lessonIds, findingIds.');
  expect(context.instructions).toContain('Cite findingIds when an insight builds on your finished research');
  expect(JSON.parse(context.input).researchState.findings).toEqual([{
    id: setup.finding.id,
    caveats: researchOutput.caveats,
    question: 'Does LightGBM support Windows ARM64?',
    verdict: 'supported',
    claims: [{
      text: claimText,
      urls: ['https://library.example/platform'],
      titles: [],
    }],
    validity: 'current',
  }]);
});

it('explains research-backed suggestions and inconclusive caveats in Checker v3', () => {
  expect(CHECKER_PROMPT).toContain('checker-v3');
  expect(CHECKER_PROMPT).toContain("('I checked: …')");
  expect(CHECKER_PROMPT).toContain("('so I'd …')");
  expect(CHECKER_PROMPT).toContain('With verdict inconclusive');
  expect(CHECKER_PROMPT).toContain('using the caveats');
  expect(CHECKER_PROMPT).toContain('or the insight text when it names an option as a suggestion');
  expect(CHECKER_PROMPT).toContain('Inference/clarification claimsUsed is empty.');
  expect(CHECKER_PROMPT).toContain('Must never add facts, numbers, names or links absent from the payload.');
});
