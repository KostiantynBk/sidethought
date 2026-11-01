import { expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';
import { readyOutput } from './t03-helpers.js';

function delivering() {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Use a local interface.');
  h.passReply();
  h.nominate([{
    kind: 'insight', topic: 'Interface', insight: 'Use a local interface.', depItemIds: [item], scores,
  }]);
  h.timer('floorGap');
  h.check();
  const candidate = Object.values(h.state.domain.initiative.candidates)[0]!;
  expect(candidate.state).toBe('delivering');
  return { h, candidate, item };
}

it('interruption becomes a card after the new input is interpreted', () => {
  const { h, candidate } = delivering();
  h.send('input.committed', { clientMsgId: 'interrupt', text: 'Another thought.', modality: 'text' });
  expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('interrupted');
  h.interpret();
  expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('card_only');
  expect(h.effects.some(e => e.type === 'client.send' && e.message.type === 'assistant.stopped'
    && e.message.deliveryId === candidate.deliveryId)).toBe(true);
  h.store.close();
});

it('dismissal drops the interrupted topic and rejects a later nomination', () => {
  const { h, candidate, item } = delivering();
  h.send('input.committed', { clientMsgId: 'dismiss', text: 'Skip that.', modality: 'text' });
  const inputId = h.state.domain.call!.inputIds[0]!;
  h.interpret({ ...readyOutput, inputKinds: [{ inputId, kind: 'dismissal' }] });
  expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('dropped');
  expect(h.state.domain.initiative.dismissedTopics).toContain(candidate.topicKey);
  h.send('item.action', { itemId: item, expectedVersion: 1, action: 'edit', text: 'Use a local display.' });
  h.nominate([{
    kind: 'insight', topic: 'Interface', insight: 'Use a local display.', depItemIds: [item], scores,
  }]);
  expect(Object.values(h.state.domain.initiative.candidates)).toHaveLength(1);
  h.store.close();
});
