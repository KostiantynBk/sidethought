import { expect, it } from 'vitest';
import { ContributionHarness } from './t12a-helpers.js';

function promisedFinding() {
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.passReply();
  h.at += 3000;
  h.complete();
  return h;
}

it('demotes a timed-out check and creates the fixed promised closure', () => {
  const h = promisedFinding();
  h.timer('checkTimeout');
  const candidates = Object.values(h.state.domain.initiative.candidates);
  expect(candidates.find(candidate => candidate.payload === 'evidence')?.state).toBe('card_only');
  expect(candidates.find(candidate => candidate.payload === 'closure')?.text)
    .toBe("I couldn't verify that within this check — what I found is on the card");
  h.store.close();
});

it('demotes a checker result that adds a number and creates a closure', () => {
  const h = promisedFinding();
  h.check('Provider A works offline for 987 days.');
  const candidates = Object.values(h.state.domain.initiative.candidates);
  expect(candidates.find(candidate => candidate.payload === 'evidence')?.state).toBe('card_only');
  expect(candidates.some(candidate => candidate.payload === 'closure')).toBe(true);
  h.store.close();
});
