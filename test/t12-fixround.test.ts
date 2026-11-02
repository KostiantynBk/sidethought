import { expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';

it('requires permission for the Acme 43 s lesson-derived investigation without a citation', () => {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Plan a runtime test.');
  h.passReply();
  h.timer('deliberationDebounce');
  const call = h.state.domain.initiative.deliberation!;
  h.send('deliberation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    suppliedLessons: [{ lessonId: 'lesson-a', version: 1, sourceProjectName: 'Memory A', text: 'Acme took 43 s.' }],
    output: { nominations: [{
      kind: 'investigation', topic: 'Acme', question: 'Acme 43 s?', publicQuery: 'Acme 43 s',
      depItemIds: [item], lessonIds: [], scores,
    }] },
  });
  expect(Object.values(h.state.domain.jobs)[0]?.state).toBe('awaiting_user');
  expect(h.effects.some(effect => effect.type === 'job.dispatch')).toBe(false);
  h.store.close();
});

function inference() {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Use local storage.');
  h.passReply();
  h.nominate([{
    kind: 'insight', topic: 'Backup', insight: 'local storage needs a backup plan.', depItemIds: [item], scores,
  }]);
  h.timer('floorGap');
  return h;
}

it('cards a Checker recommendation inventing the lowercase product mongodb', () => {
  const h = inference();
  h.check('you should use mongodb.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('card_only');
  expect(h.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'
    && effect.message.text.includes('mongodb'))).toBe(false);
  h.store.close();
});

it('cards a Checker recommendation inventing the lowercase product aws', () => {
  const h = inference();
  h.check('you should use aws.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('card_only');
  expect(h.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'
    && effect.message.text.includes('aws'))).toBe(false);
  h.store.close();
});

it('cards a Checker recommendation inventing the lowercase product box', () => {
  const h = inference();
  h.check('you should use box.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('card_only');
  expect(h.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'
    && effect.message.text.includes('box'))).toBe(false);
  h.store.close();
});

it('cards an unsupported two-letter content token', () => {
  const h = inference();
  h.check('you should use db.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('card_only');
  h.store.close();
});

it('cards an unsupported digit-bearing identifier', () => {
  const h = inference();
  h.check('you should use s3.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('card_only');
  h.store.close();
});

it('allows an ordinary paraphrase grounded in the inference payload', () => {
  const h = inference();
  h.check('You should have a backup plan for local storage.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('delivering');
  h.store.close();
});

function startedEvidence() {
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.passReply();
  h.at += 3000;
  const text = 'Edits work offline.';
  const url = 'https://example.com';
  h.complete(undefined, {
    verdict: 'supported',
    claims: [{ text, support: [{ url, quote: text, sourceKind: 'official' }] }],
    caveats: [],
  }, {
    completedSearchCalls: 1,
    issuedQueries: ['Provider A offline'],
    results: [{ url, snippet: text }],
  });
  h.check(text);
  const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'evidence')!;
  expect(candidate.state).toBe('delivering');
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(0);
  return { h, candidate };
}

it('does not add a fixed closure after the full evidence prefix is interrupted', () => {
  const { h, candidate } = startedEvidence();
  h.send('input.committed', { clientMsgId: 'thanks', text: 'Thanks.', modality: 'text', renderedUpTo: 19 });
  h.interpret();
  h.passReply();
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
  expect(Object.values(h.state.domain.initiative.candidates).some(c => c.payload === 'closure')).toBe(false);
  h.store.close();
});

it('does not add a fixed closure after rendered non-final progress and interruption', () => {
  const { h, candidate } = startedEvidence();
  h.send('delivery.progress', {
    deliveryId: candidate.deliveryId,
    chunkIdx: 0,
    chars: 19,
    final: false,
    reason: 'rendered',
  });
  h.send('input.committed', { clientMsgId: 'thanks', text: 'Thanks.', modality: 'text' });
  h.interpret();
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
  expect(Object.values(h.state.domain.initiative.candidates).some(c => c.payload === 'closure')).toBe(false);
  h.store.close();
});

it('does not add a fixed closure after rendered non-final progress and recovery', () => {
  const { h, candidate } = startedEvidence();
  h.send('delivery.progress', {
    deliveryId: candidate.deliveryId,
    chunkIdx: 0,
    chars: 19,
    final: false,
    reason: 'rendered',
  });
  h.send('session.recovered', {});
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
  expect(Object.values(h.state.domain.initiative.candidates).some(c => c.payload === 'closure')).toBe(false);
  h.store.close();
});

it('cards evidence when the Checker adds an unsupported lowercase product', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.passReply();
  h.at += 3000;
  h.complete();
  h.check('Provider A edits work offline after first sign-in with mongodb.');
  const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'evidence')!;
  expect(candidate.state).toBe('card_only');
  h.store.close();
});

it('makes a consequence-three clarification eligible to speak', () => {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Use local storage.');
  h.passReply();
  h.nominate([{
    kind: 'clarification',
    topic: 'Storage',
    question: 'What storage?',
    depItemIds: [item],
    scores: { ...scores, consequence: 3 },
  }]);
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.class).toBe('speak');
  h.store.close();
});

it('makes a consequence-two clarification a card', () => {
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Use local storage.');
  h.passReply();
  h.nominate([{ kind: 'clarification', topic: 'Storage', question: 'What storage?', depItemIds: [item], scores }]);
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.class).toBe('card');
  h.store.close();
});
