import { expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';

function pendingInsight() {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Use a local interface.');
  h.nominate([{
    kind: 'insight',
    topic: 'Interface',
    insight: 'Use a local interface.',
    depItemIds: [item],
    scores,
  }]);
  return h;
}

it('a pending reply blocks a contribution until reply completion and the floor gap', () => {
  const h = pendingInsight();
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('candidate');
  h.passReply();
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('candidate');
  h.timer('floorGap');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('checking');
  h.store.close();
});

it('composer activity blocks a candidate after the reply', () => {
  const h = pendingInsight();
  h.send('input.activity', { channel: 'composer', active: true });
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('candidate');
  h.send('input.activity', { channel: 'composer', active: false });
  h.passReply();
  h.timer('floorGap');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('checking');
  h.store.close();
});

it('an uninterpreted committed input blocks the candidate', () => {
  const h = pendingInsight();
  h.passReply();
  h.send('input.committed', { clientMsgId: 'next', text: 'Another thought.', modality: 'text' });
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('candidate');
  h.interpret();
  h.passReply();
  h.timer('floorGap');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('checking');
  h.store.close();
});
