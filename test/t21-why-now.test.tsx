import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientMessageSchema, type Finding } from '../src/contract/index.js';
import { contributionView } from '../src/kernel/contributions/common.js';
import { projectContributions } from '../src/kernel/index.js';
import { ContributionPanel } from '../web/src/ContributionPanel.js';
import { Conversation } from '../web/src/components.js';
import { emptyView, nextView, type ContributionView } from '../web/src/logic/view.js';
import { whyNow } from '../web/src/logic/why-now.js';
import { ContributionHarness, scores } from './t12a-helpers.js';

const base: ContributionView = {
  candidateId: 'c1', class: 'speak', payload: 'inference', state: 'delivered', topic: 'Topic', text: 'Idea',
  deliveryId: 'd1',
};
const lesson = { lessonId: 'l1', version: 1, sourceProjectName: 'Project A', text: 'Lesson' };
const finding: Finding = {
  id: 'f1', jobId: 'j1', questionKey: 'q', retrievedAt: 1, basisRev: 0,
  inputDeps: [], deps: [], rebases: [], validity: { state: 'current' }, verdict: 'not_researched',
  claims: [], caveats: [], retrievalEvidence: { completedSearchCalls: 0, issuedQueries: [], results: [] },
};
const view = {
  ...emptyView(),
  jobs: [{ jobId: 'j1', publicQuery: 'Does it work?', state: 'succeeded' }],
  findings: [finding],
};

it('explains evidence using its finding job question', () => {
  expect(whyNow({ ...base, payload: 'evidence', findingId: 'f1' }, view))
    .toBe('Why now: your check finished — "Does it work?"');
});

it('uses a direct job reference for evidence', () => {
  expect(whyNow({ ...base, payload: 'evidence', jobId: 'j1' }, view))
    .toBe('Why now: your check finished — "Does it work?"');
});

it('explains research-backed inference using the first finding job question', () => {
  expect(whyNow({ ...base, findingIds: ['f1'] }, view))
    .toBe('Why now: built on research it ran — "Does it work?"');
});

it('explains an inference based on a reviewed lesson', () => {
  expect(whyNow({ ...base, lessons: [lesson] }, view)).toBe('Why now: a reviewed lesson from Project A');
});

it('combines research and lesson reasons', () => {
  expect(whyNow({ ...base, findingIds: ['f1'], lessons: [lesson] }, view))
    .toBe('Why now: built on research it ran — "Does it work?"; a reviewed lesson from Project A');
});

it('explains an inference without research or lessons', () => {
  expect(whyNow(base, view)).toBe('Why now: a tension between items in your plan');
});

it('explains clarification', () => {
  expect(whyNow({ ...base, payload: 'clarification' }, view)).toBe('Why now: the answer changes your plan');
});

it('explains closure', () => {
  expect(whyNow({ ...base, payload: 'closure' }, view)).toBe('Why now: closing a check it promised');
});

it('falls back when an evidence question is unknown', () => {
  expect(whyNow({ ...base, payload: 'evidence', findingId: 'missing' }, view))
    .toBe('Why now: your check finished');
});

it('falls back when a research inference question is unknown', () => {
  expect(whyNow({ ...base, findingIds: ['missing'] }, view)).toBe('Why now: built on research it ran');
});

it('truncates long questions', () => {
  const longView = { ...view, jobs: [{ jobId: 'j1', publicQuery: 'x'.repeat(100), state: 'succeeded' }] };
  expect(whyNow({ ...base, findingIds: ['f1'] }, longView))
    .toBe(`Why now: built on research it ran — "${'x'.repeat(79)}…"`);
});

it('includes finding IDs in both contribution and snapshot projections', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  const item = h.statement('Use a local interface.');
  h.passReply();
  h.nominate([{ kind: 'insight', topic: 'Local', insight: 'Use a local interface.', depItemIds: [item], scores }]);
  const state = h.state;
  const candidate = Object.values(state.domain.initiative.candidates)[0]!;
  candidate.source.findingIds = ['f1', 'f2'];
  expect(contributionView(candidate).findingIds).toEqual(['f1', 'f2']);
  expect(projectContributions(state)[0]?.findingIds).toEqual(['f1', 'f2']);
  h.store.close();
});

it('omits empty finding IDs from both contribution and snapshot projections', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  const item = h.statement('Use a local interface.');
  h.passReply();
  h.nominate([{ kind: 'insight', topic: 'Local', insight: 'Use a local interface.', depItemIds: [item], scores }]);
  const state = h.state;
  const candidate = Object.values(state.domain.initiative.candidates)[0]!;
  candidate.source.findingIds = [];
  expect(contributionView(candidate)).not.toHaveProperty('findingIds');
  expect(projectContributions(state)[0]).not.toHaveProperty('findingIds');
  h.store.close();
});

it('accepts contribution messages with finding IDs', () => {
  expect(ClientMessageSchema.parse({ type: 'contribution.upserted', ...base, findingIds: ['f1'] }))
    .toHaveProperty('findingIds', ['f1']);
});

it('accepts contribution messages without finding IDs', () => {
  expect(ClientMessageSchema.parse({ type: 'contribution.upserted', ...base })).not.toHaveProperty('findingIds');
});

it('renders a why-now label on an unprompted transcript row', () => {
  let current = nextView(view, { type: 'contribution.upserted', ...base, findingIds: ['f1'] });
  current = nextView(current, { type: 'assistant.chunk', deliveryId: 'd1', chunkIdx: 0, text: 'Idea' });
  expect(renderToStaticMarkup(<Conversation view={current} />)).toContain('Why now: built on research it ran');
});

it('does not render a why-now label on an assistant reply', () => {
  const current = nextView(view, { type: 'assistant.chunk', deliveryId: 'reply', chunkIdx: 0, text: 'Reply' });
  expect(renderToStaticMarkup(<Conversation view={current} />)).not.toContain('Why now:');
});

it('renders the research-based reason on a contribution card', () => {
  const html = renderToStaticMarkup(<ContributionPanel contributions={[{ ...base, findingIds: ['f1'] }]}
    jobs={view.jobs} findings={view.findings} onApprove={() => undefined} onDecline={() => undefined} />);
  expect(html).toContain('Why now: built on research it ran');
  expect(html).toContain('Does it work?');
});
