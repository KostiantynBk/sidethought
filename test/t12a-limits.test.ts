import { expect, it } from 'vitest';
import { ContributionHarness } from './t12a-helpers.js';
import { readyOutput } from './t03-helpers.js';

it('refuses a fourth Deliberator run for the same input', () => {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const text = 'Use local storage. Check offline, pricing, and licensing.';
  h.send('input.committed', { clientMsgId: 'origin', text, modality: 'text' });
  const inputId = h.state.domain.call!.inputIds[0]!;
  h.interpret({
    ...readyOutput,
    inputKinds: [{ inputId, kind: 'statement' }],
    ops: [{
      op: 'create', kind: 'requirement', status: 'stated', text: 'Use local storage',
      quoteSpans: [{ inputId, start: 0, end: 17, quote: 'Use local storage' }],
    }],
    researchRequests: ['offline', 'pricing', 'licensing'].map(topic => ({
      inputId,
      question: `Check ${topic}?`,
      publicQuery: `public ${topic}`,
      depItemIds: [],
    })),
  });
  expect(Object.values(h.state.domain.items)).toHaveLength(1);
  h.nominate([]);
  const jobs = Object.values(h.state.domain.jobs);
  for (const job of jobs) {
    h.complete(job.id);
    h.timer('deliberationDebounce');
    if (h.state.domain.initiative.deliberation) h.nominate([]);
  }
  expect(h.effects.filter(e => e.type === 'llm.call' && e.role === 'deliberator')).toHaveLength(3);
  expect(h.effects.some(e => e.type === 'client.send' && e.message.type === 'inspector.decision'
    && e.message.reason === 'contribution:deliberator:input_limit')).toBe(true);
  h.store.close();
});
