import { expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';
import { readyOutput } from './t03-helpers.js';

function conflict() {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const first = h.statement('No copies outside the phone.');
  const second = h.statement('Recover everything after losing it.');
  h.passReply();
  h.nominate([{
    kind: 'insight',
    topic: 'Recovery conflict',
    insight: 'No copies outside the phone conflicts with recovering everything after losing it.',
    depItemIds: [first, second],
    scores,
  }]);
  return { h, first };
}

it('scenario 2: checks and delivers an inference citing two stated items', () => {
  const { h } = conflict();
  h.timer('floorGap');
  h.check('No copies outside the phone conflicts with recovering everything after losing it.');
  h.acknowledge();
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('delivered');
  h.store.close();
});

it('scenario 2: drops the inference when a dependency is superseded', () => {
  const { h, first } = conflict();
  const text = 'Allow encrypted copies.';
  h.send('input.committed', { clientMsgId: 'replace', text, modality: 'text' });
  const inputId = h.state.domain.call!.inputIds[0]!;
  const span = { inputId, start: 0, end: text.length, quote: text };
  h.interpret({
    ...readyOutput,
    inputKinds: [{ inputId, kind: 'correction' }],
    ops: [{
      op: 'supersede',
      itemId: first,
      quoteSpans: [span],
      replacement: { kind: 'requirement', status: 'stated', text, quoteSpans: [span] },
    }],
  });
  h.passReply();
  h.timer('floorGap');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('dropped');
  h.store.close();
});

it('restraint: a low-consequence insight is card-only and not spoken', () => {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Use a local interface.');
  h.passReply();
  h.nominate([{
    kind: 'insight',
    topic: 'Interface',
    insight: 'Use a local interface.',
    depItemIds: [item],
    scores: { ...scores, consequence: 1 },
  }]);
  const candidate = Object.values(h.state.domain.initiative.candidates)[0]!;
  expect(candidate.state).toBe('card_only');
  expect(h.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'
    && effect.message.deliveryId === candidate.deliveryId)).toBe(false);
  h.store.close();
});
