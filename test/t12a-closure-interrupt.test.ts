import { expect, it } from 'vitest';
import { ContributionHarness } from './t12a-helpers.js';

function startedClosure() {
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.passReply();
  h.at += 3000;
  h.complete();
  h.timer('checkTimeout');
  const closure = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'closure')!;
  expect(closure.state).toBe('delivering');
  expect(h.state.domain.jobs[closure.jobId!]?.closureCount).toBe(1);
  return { h, id: closure.id };
}

it('never repeats a fixed closure interrupted after its first chunk', () => {
  const { h, id } = startedClosure();
  h.send('input.committed', { clientMsgId: 'interrupt', text: 'Hold on.', modality: 'text' });
  const closure = h.state.domain.initiative.candidates[id]!;
  expect(closure.state).toBe('card_only');
  expect(closure.text).toBe("I couldn't verify that within this check — what I found is on the card");
  expect(h.state.domain.jobs[closure.jobId!]?.closureCount).toBe(1);
  h.interpret();
  expect(Object.values(h.state.domain.initiative.candidates).filter(c => c.payload === 'closure')).toHaveLength(1);
  h.store.close();
});

it('never repeats a fixed closure recovered after its first chunk', () => {
  const { h, id } = startedClosure();
  h.send('session.recovered', {});
  const closure = h.state.domain.initiative.candidates[id]!;
  expect(closure.state).toBe('card_only');
  expect(closure.text).toBe("I couldn't verify that within this check — what I found is on the card");
  expect(h.state.domain.jobs[closure.jobId!]?.closureCount).toBe(1);
  expect(Object.values(h.state.domain.initiative.candidates).filter(c => c.payload === 'closure')).toHaveLength(1);
  h.store.close();
});
