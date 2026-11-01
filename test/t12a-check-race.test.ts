import { expect, it } from 'vitest';
import { ContributionHarness } from './t12a-helpers.js';

function checking() {
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.passReply();
  h.at += 3000;
  h.complete();
  const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.state === 'checking')!;
  return { h, id: candidate.id };
}

it('applies false demotes evidence and produces a fixed closure', () => {
  const { h, id } = checking();
  const call = h.state.domain.initiative.candidates[id]!.check!;
  h.send('check.ready', {
    requestId: call.requestId,
    callId: call.callId,
    output: { applies: false, reason: 'Obsolete', utterance: '', claimsUsed: [] },
  });
  expect(h.state.domain.initiative.candidates[id]?.state).toBe('card_only');
  expect(Object.values(h.state.domain.initiative.candidates).some(c => c.payload === 'closure')).toBe(true);
  h.store.close();
});

it('rechecks once after a new input and cards after a second input race', () => {
  const { h, id } = checking();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const call = h.state.domain.initiative.candidates[id]!.check!;
    h.send('input.committed', { clientMsgId: `race-${attempt}`, text: 'Another thought.', modality: 'text' });
    h.send('check.ready', {
      requestId: call.requestId,
      callId: call.callId,
      output: { applies: true, reason: 'Old basis', utterance: 'Provider A edits work offline', claimsUsed: [] },
    });
    h.interpret();
    h.passReply();
    if (attempt === 0) {
      h.timer('floorGap');
      expect(h.state.domain.initiative.candidates[id]?.state).toBe('checking');
    }
  }
  expect(h.state.domain.initiative.candidates[id]?.state).toBe('card_only');
  h.store.close();
});
