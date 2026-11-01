import { expect, it } from 'vitest';
import { projectContributions } from '../src/kernel/index.js';
import { ContributionHarness, scores } from './t12a-helpers.js';

it('projects the same contribution fields sent to the client and identifies inspector candidates', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  const item = h.statement('Use a local interface.');
  h.passReply();
  h.nominate([{
    kind: 'insight',
    topic: 'Local interface',
    insight: 'Use a local interface.',
    depItemIds: [item],
    scores: { ...scores, consequence: 1 },
  }]);
  const candidate = Object.values(h.state.domain.initiative.candidates)[0]!;
  const view = projectContributions(h.state);
  const sent = h.effects.filter(effect => effect.type === 'client.send'
    && effect.message.type === 'contribution.upserted'
    && effect.message.candidateId === candidate.id).at(-1);
  expect(sent?.type).toBe('client.send');
  if (sent?.type !== 'client.send' || sent.message.type !== 'contribution.upserted') throw new Error('missing view');
  const { type: _type, ...message } = sent.message;
  expect(view).toEqual([message]);
  expect(h.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'inspector.decision'
    && effect.message.reason === `contribution:class:card candidate=${candidate.id}`)).toBe(true);
  h.store.close();
});
