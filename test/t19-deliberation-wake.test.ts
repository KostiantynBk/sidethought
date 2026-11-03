import { expect, it } from 'vitest';
import { readyOutput } from './t03-helpers.js';
import { ContributionHarness } from './t12a-helpers.js';

const message = 'I am planning my entry. I will train locally on my laptop, which is Windows on ARM.';
const partial = 'I will train locally on my laptop';

function debounced(h: ContributionHarness): boolean {
  return h.state.domain.timers.some(timer => timer.purpose === 'deliberationDebounce');
}

it('wakes the Deliberator when every proposed item of a final turn is rejected as a partial clause', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  h.send('input.committed', { clientMsgId: 'm-1', text: message, modality: 'text' });
  const inputId = h.state.domain.call!.inputIds[0]!;
  const start = message.indexOf(partial);
  const rev = h.state.domain.projectRev;
  h.interpret({
    ...readyOutput,
    inputKinds: [{ inputId, kind: 'statement' }],
    ops: [{
      op: 'create',
      kind: 'decision',
      status: 'stated',
      text: 'Train locally on the laptop',
      quoteSpans: [{ inputId, start, end: start + partial.length, quote: partial }],
    }],
  });
  expect(h.state.domain.projectRev).toBe(rev);
  expect(h.state.domain.inputs.find(input => input.id === inputId)?.status).toBe('interpreted');
  expect(debounced(h)).toBe(true);
  h.store.close();
});

it('does not wake the Deliberator for a final turn that proposes nothing and changes nothing', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  h.send('input.committed', { clientMsgId: 'm-1', text: 'Thanks.', modality: 'text' });
  const inputId = h.state.domain.call!.inputIds[0]!;
  h.interpret({ ...readyOutput, inputKinds: [{ inputId, kind: 'statement' }], ops: [] });
  expect(debounced(h)).toBe(false);
  h.store.close();
});

it('drops a stray non-item reference from a nomination and keeps the nomination', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  const itemId = h.statement('Use a local interface.');
  h.nominate([{
    kind: 'insight',
    insight: 'A local interface keeps the first test fast.',
    lessonIds: [],
    topic: 'local interface',
    depItemIds: [itemId, 'input-not-an-item'],
    scores: { consequence: 2, uncertainty: 1, answerable: true, urgency: 1, needsPrivateDetail: false },
  }]);
  const candidates = Object.values(h.state.domain.initiative.candidates);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.deps.map(dep => dep.itemId)).toEqual([itemId]);
  h.store.close();
});
