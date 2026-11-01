import { expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';

it('debounces two user changes into one Deliberator run', () => {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  h.statement('Use a local interface.');
  const first = h.state.domain.timers.find(t => t.purpose === 'deliberationDebounce')!;
  h.statement('Keep setup simple.');
  const timers = h.state.domain.timers.filter(t => t.purpose === 'deliberationDebounce');
  expect(timers).toHaveLength(1);
  expect(timers[0]!.timerId).not.toBe(first.timerId);
  h.timer('deliberationDebounce');
  expect(h.effects.filter(e => e.type === 'llm.call' && e.role === 'deliberator')).toHaveLength(1);
  h.store.close();
});

it('coalesces a change during a Deliberator call into one subsequent run', () => {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  h.statement('Use a local interface.');
  h.timer('deliberationDebounce');
  const first = h.state.domain.initiative.deliberation!;
  h.statement('Keep setup simple.');
  expect(h.state.domain.initiative.deliberation?.callId).toBe(first.callId);
  h.send('deliberation.ready', {
    requestId: first.requestId,
    callId: first.callId,
    output: { nominations: [] },
  });
  expect(h.state.domain.initiative.deliberation?.callId).not.toBe(first.callId);
  expect(h.effects.filter(e => e.type === 'llm.call' && e.role === 'deliberator')).toHaveLength(2);
  h.store.close();
});

it('a finding-triggered depth-one investigation awaits approval and then becomes promised', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.complete();
  h.timer('deliberationDebounce');
  expect(h.state.domain.initiative.deliberation?.causalDepth).toBe(1);
  h.nominate([{
    kind: 'investigation',
    topic: 'Follow-up pricing',
    question: 'What is the pricing?',
    publicQuery: 'Provider A public pricing',
    depItemIds: ['r1'],
    scores,
  }]);
  const job = Object.values(h.state.domain.jobs).find(j => j.causalDepth === 1)!;
  expect(job.state).toBe('awaiting_user');
  expect(job.promised).toBe(false);
  const card = Object.values(h.state.domain.initiative.candidates).find(c => c.jobId === job.id)!;
  expect(card.text).toContain(job.publicQuery);
  h.send('job.approve', { jobId: job.id });
  expect(h.state.domain.jobs[job.id]?.promised).toBe(true);
  expect(['queued', 'running']).toContain(h.state.domain.jobs[job.id]?.state);
  h.store.close();
});
