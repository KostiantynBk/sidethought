import { expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';

function twoCandidates() {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Use a local interface.');
  h.passReply();
  h.nominate([
    { kind: 'insight', topic: 'First topic', insight: 'Use a local interface.', depItemIds: [item], scores },
    { kind: 'insight', topic: 'Second topic', insight: 'Use a local interface.', depItemIds: [item], scores },
  ]);
  h.timer('floorGap');
  h.check();
  h.acknowledge();
  return h;
}

it('waits the full spacing interval before checking the second Speak candidate', () => {
  const h = twoCandidates();
  const second = Object.values(h.state.domain.initiative.candidates)[1]!;
  expect(second.state).toBe('candidate');
  h.timer('floorGap');
  const timer = h.state.domain.timers.find(t => t.purpose === 'rateLimit')!;
  expect(timer.dueAt).toBe(h.state.domain.initiative.lastSpeakAt! + 45000);
  h.timer('rateLimit');
  expect(h.state.domain.initiative.candidates[second.id]?.state).toBe('checking');
  h.store.close();
});

it('expires a waiting Speak candidate to a card', () => {
  const h = new ContributionHarness('memory', { speakSpacingMs: 600000 }, []);
  h.connect();
  const item = h.statement('Use a local interface.');
  h.passReply();
  h.nominate([
    { kind: 'insight', topic: 'First topic', insight: 'Use a local interface.', depItemIds: [item], scores },
    { kind: 'insight', topic: 'Second topic', insight: 'Use a local interface.', depItemIds: [item], scores },
  ]);
  h.timer('floorGap');
  h.check();
  h.acknowledge();
  const second = Object.values(h.state.domain.initiative.candidates)[1]!;
  h.timer('candidateExpiry');
  expect(h.state.domain.initiative.candidates[second.id]?.state).toBe('card_only');
  h.store.close();
});
