import { expect, it } from 'vitest';
import { DeliverySchema, EventSchema } from '../src/contract/index.js';
import { promised_closed_once } from '../src/harness/research-invariants.js';
import type { ContributionHarness } from './t12a-helpers.js';
import {
  closureCandidates, finishFixedClosure, firstClaim, fixedClosure, interrupt, startEvidence,
} from './t12fix2-promise-helpers.js';

function chunks(h: ContributionHarness): string[] {
  return h.effects.flatMap(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'
    ? [effect.message.text] : []);
}

function idle(h: ContributionHarness): void {
  h.at += 1500;
  h.send('input.activity', { channel: 'composer', active: false });
}

function recoverWithoutWork(h: ContributionHarness): void {
  const recovered = h.send('session.recovered', {});
  expect(recovered.effects.some(effect => effect.type === 'llm.call' || effect.type === 'job.dispatch'
    || (effect.type === 'client.send' && effect.message.type === 'assistant.chunk'))).toBe(false);
}

function releaseFloor(h: ContributionHarness): void {
  for (let step = 0; step < 5; step++) {
    const timer = h.state.domain.timers.find(value => ['floorGap', 'rateLimit'].includes(value.purpose));
    if (!timer) break;
    h.timer(timer.purpose);
  }
}

for (const kind of ['memory', 'sqlite'] as const) {
  for (const offset of [0, 5, 19]) {
    it(`${kind}: composer active then idle preserves ownership until commit ${offset}`, () => {
      const { h, candidate, delivery } = startEvidence(kind);
      h.send('input.activity', { channel: 'composer', active: true });
      expect(h.state.domain.deliveries[delivery.id]?.awaitingCommitOffset).toBe(true);
      idle(h);
      expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('card_only');
      const waiting = h.store.loadSnapshot('s')!.state.domain.deliveries[delivery.id]!;
      expect(DeliverySchema.parse(JSON.parse(JSON.stringify(waiting))).awaitingCommitOffset).toBe(true);
      expect(waiting.promiseWitness).toBe('evidence_uncertain');
      expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
      expect(closureCandidates(h)).toHaveLength(0);
      interrupt(h, offset);
      const settled = h.state.domain.deliveries[delivery.id]!;
      expect(settled.awaitingCommitOffset).toBeUndefined();
      expect(settled.renderedOffsetKnown).toBe(true);
      expect(settled.deliveredChars).toBe(offset);
      expect(settled.interruptedPrefix).toBe(offset === 19 ? firstClaim : offset === 5 ? 'Edits' : '');
      expect(settled.promiseWitness).toBe(offset === 19 ? 'evidence_rendered' : 'evidence_incomplete');
      expect(settled.claimsDelivered).toHaveLength(offset === 19 ? 1 : 0);
      expect(settled.chunks).toEqual([{
        text: firstClaim.slice(0, offset),
        state: offset ? 'rendered' : 'discarded',
        claimIds: offset === 19 ? [`${candidate.source.findingId}:claim:0`] : [],
        sentenceFinished: offset === 19,
      }]);
      expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(offset === 19 ? 1 : 0);
      expect(chunks(h)).toEqual([firstClaim]);
      if (offset === 19) {
        h.interpret();
        h.passReply();
        releaseFloor(h);
        expect(closureCandidates(h)).toHaveLength(0);
        h.send('client.disconnected', {});
        h.connect();
        releaseFloor(h);
      } else {
        expect(closureCandidates(h)).toHaveLength(1);
        expect(closureCandidates(h)[0]?.state).toBe('candidate');
        finishFixedClosure(h, candidate.jobId!);
      }
      const expected = offset === 19 ? [firstClaim] : [firstClaim, fixedClosure];
      expect(chunks(h)).toEqual(expected);
      recoverWithoutWork(h);
      h.connect();
      releaseFloor(h);
      expect(chunks(h)).toEqual(expected);
      expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
      h.store.close();
    });
  }

  for (const progress of [0, 5]) {
    for (const withIdle of [false, true]) {
      const ordering = `progress ${progress} then composer${withIdle ? ' and idle' : ''} then commit 19`;
      it(`${kind}: ${ordering} closes evidence`, () => {
        const { h, candidate, delivery } = startEvidence(kind);
        h.send('delivery.progress', {
          deliveryId: delivery.id,
          chunkIdx: 0,
          chars: progress,
          final: false,
          reason: 'rendered',
        });
        h.send('input.activity', { channel: 'composer', active: true });
        expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_incomplete');
        expect(h.state.domain.deliveries[delivery.id]?.awaitingCommitOffset).toBe(true);
        expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(0);
        if (withIdle) {
          idle(h);
          expect(closureCandidates(h)).toHaveLength(1);
          expect(closureCandidates(h)[0]?.state).toBe('candidate');
        }
        interrupt(h, 19);
        const settled = h.state.domain.deliveries[delivery.id]!;
        expect(settled.deliveredChars).toBe(19);
        expect(settled.interruptedPrefix).toBe(firstClaim);
        expect(settled.claimsDelivered).toEqual([`${candidate.source.findingId}:claim:0`]);
        expect(settled.promiseWitness).toBe('evidence_rendered');
        expect(settled.awaitingCommitOffset).toBeUndefined();
        expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
        expect(closureCandidates(h)).toHaveLength(withIdle ? 1 : 0);
        if (withIdle) expect(closureCandidates(h)[0]?.state).toBe('dropped');
        h.interpret();
        h.passReply();
        releaseFloor(h);
        expect(chunks(h)).toEqual([firstClaim]);
        h.send('client.disconnected', {});
        h.connect();
        releaseFloor(h);
        recoverWithoutWork(h);
        h.connect();
        releaseFloor(h);
        expect(chunks(h)).toEqual([firstClaim]);
        expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
        h.store.close();
      });
    }
  }
}

it('a lower authoritative commit never decreases an acknowledged prefix', () => {
  const { h, candidate, delivery } = startEvidence('memory');
  h.send('delivery.progress', {
    deliveryId: delivery.id,
    chunkIdx: 0,
    chars: 5,
    final: false,
    reason: 'rendered',
  });
  h.send('input.activity', { channel: 'composer', active: true });
  idle(h);
  interrupt(h, 0);
  const settled = h.state.domain.deliveries[delivery.id]!;
  expect(settled.deliveredChars).toBe(5);
  expect(settled.interruptedPrefix).toBe('Edits');
  expect(settled.promiseWitness).toBe('evidence_incomplete');
  expect(settled.claimsDelivered).toEqual([]);
  expect(settled.awaitingCommitOffset).toBeUndefined();
  finishFixedClosure(h, candidate.jobId!);
  expect(chunks(h)).toEqual([firstClaim, fixedClosure]);
  h.store.close();
});

for (const boundary of ['client.disconnected', 'session.recovered'] as const) {
  it(`${boundary} clears composer ownership so an older delivery cannot take a later offset`, () => {
    const { h, candidate, delivery } = startEvidence('memory');
    h.send('input.activity', { channel: 'composer', active: true });
    idle(h);
    expect(h.state.domain.deliveries[delivery.id]?.awaitingCommitOffset).toBe(true);
    if (boundary === 'session.recovered') recoverWithoutWork(h);
    else h.send(boundary, {});
    expect(h.state.domain.deliveries[delivery.id]?.awaitingCommitOffset).toBeUndefined();
    h.connect();
    interrupt(h, 0);
    h.interpret();
    h.passReply();
    releaseFloor(h);
    const settled = h.state.domain.deliveries[delivery.id]!;
    expect(settled.deliveredChars).toBe(0);
    expect(settled.renderedOffsetKnown).not.toBe(true);
    expect(settled.promiseWitness).toBe('evidence_uncertain');
    expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
    expect(closureCandidates(h)).toHaveLength(0);
    expect(chunks(h)).toEqual([firstClaim]);
    h.store.close();
  });
}

it('a newer evidence owner takes the offset instead of an older disconnected delivery', () => {
  const { h, candidate: oldCandidate, delivery: oldDelivery } = startEvidence('memory');
  h.send('input.activity', { channel: 'composer', active: true });
  h.send('client.disconnected', {});
  h.connect();
  h.request(['Can edits work offline on another device?'], 'offline edits on another device');
  h.passReply();
  h.at += 60000;
  const job = Object.values(h.state.domain.jobs).find(value => value.id !== oldCandidate.jobId)!;
  const url = 'https://example.com';
  h.complete(job.id, {
    verdict: 'supported',
    claims: [{ text: firstClaim, support: [{ url, quote: firstClaim, sourceKind: 'official' }] }],
    caveats: [],
  }, {
    completedSearchCalls: 1,
    issuedQueries: ['offline edits on another device'],
    results: [{ url, snippet: firstClaim }],
  });
  h.check(firstClaim);
  const newer = Object.values(h.state.domain.initiative.candidates).find(value => value.jobId === job.id)!;
  expect(newer.state).toBe('delivering');
  h.send('input.activity', { channel: 'composer', active: true });
  idle(h);
  interrupt(h, 5);
  const old = h.state.domain.deliveries[oldDelivery.id]!;
  expect(old.deliveredChars).toBe(0);
  expect(old.promiseWitness).toBe('evidence_uncertain');
  expect(old.renderedOffsetKnown).not.toBe(true);
  const refined = h.state.domain.deliveries[newer.deliveryId!]!;
  expect(refined.deliveredChars).toBe(5);
  expect(refined.promiseWitness).toBe('evidence_incomplete');
  expect(refined.awaitingCommitOffset).toBeUndefined();
  expect(h.state.domain.jobs[oldCandidate.jobId!]?.closureCount).toBe(1);
  finishFixedClosure(h, job.id);
  expect(chunks(h)).toEqual([firstClaim, firstClaim, fixedClosure]);
  h.store.close();
});

it('a newer fixed closure clears the old owner and is never retracted or re-spoken', () => {
  const { h, candidate, delivery } = startEvidence('memory');
  h.send('delivery.progress', {
    deliveryId: delivery.id,
    chunkIdx: 0,
    chars: 5,
    final: false,
    reason: 'rendered',
  });
  h.send('input.activity', { channel: 'composer', active: true });
  idle(h);
  releaseFloor(h);
  const closure = closureCandidates(h)[0]!;
  expect(closure.state).toBe('delivering');
  expect(h.state.domain.deliveries[delivery.id]?.awaitingCommitOffset).toBeUndefined();
  interrupt(h, 19);
  expect(h.state.domain.deliveries[delivery.id]?.deliveredChars).toBe(5);
  expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_incomplete');
  expect(h.state.domain.deliveries[closure.deliveryId!]?.deliveredChars).toBe(19);
  expect(h.state.domain.deliveries[closure.deliveryId!]?.promiseWitness).toBe('fixed_sent');
  expect(h.state.domain.initiative.candidates[closure.id]?.state).toBe('card_only');
  h.interpret();
  h.passReply();
  releaseFloor(h);
  recoverWithoutWork(h);
  h.connect();
  releaseFloor(h);
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
  expect(closureCandidates(h)).toHaveLength(1);
  expect(chunks(h)).toEqual([firstClaim, fixedClosure]);
  h.store.close();
});

it('an owner consumes only one commit offset even if a later commit reports more rendering', () => {
  const { h, candidate, delivery } = startEvidence('memory');
  h.send('input.activity', { channel: 'composer', active: true });
  idle(h);
  interrupt(h, 5);
  expect(h.state.domain.deliveries[delivery.id]?.awaitingCommitOffset).toBeUndefined();
  h.at += 1;
  interrupt(h, 19);
  expect(h.state.domain.deliveries[delivery.id]?.deliveredChars).toBe(5);
  expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_incomplete');
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(0);
  expect(chunks(h)).toEqual([firstClaim]);
  h.store.close();
});

it('promised_closed_once rejects a forged count after same-delivery evidence refinement', () => {
  const { h, candidate, delivery } = startEvidence('memory');
  h.send('delivery.progress', {
    deliveryId: delivery.id,
    chunkIdx: 0,
    chars: 5,
    final: false,
    reason: 'rendered',
  });
  h.send('input.activity', { channel: 'composer', active: true });
  idle(h);
  interrupt(h, 19);
  expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_rendered');
  expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
  const forged = structuredClone(h.state);
  forged.domain.jobs[candidate.jobId!]!.closureCount = 0;
  const event = EventSchema.parse({
    type: 'client.disconnected',
    eventId: 'forged-refinement-probe',
    sessionId: 's',
    payload: {},
  });
  expect(promised_closed_once(h.state, event, forged, [], []))
    .toContain(`promised_closed_once: witness count differs: ${candidate.jobId}`);
  h.store.close();
});

it('old delivery snapshots parse without introducing commit ownership', () => {
  const { h, delivery } = startEvidence('memory');
  const old = JSON.parse(JSON.stringify(delivery));
  delete old.awaitingCommitOffset;
  expect(DeliverySchema.parse(old)).not.toHaveProperty('awaitingCommitOffset');
  h.store.close();
});
