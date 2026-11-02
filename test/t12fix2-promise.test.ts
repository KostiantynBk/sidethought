import { expect, it } from 'vitest';
import { recentTurns } from '../src/context/recent.js';
import { promised_closed_once } from '../src/harness/research-invariants.js';
import { DeliverySchema, EventSchema } from '../src/contract/index.js';
import {
  closureCandidates, finishFixedClosure, firstClaim, interrupt, startEvidence,
} from './t12fix2-promise-helpers.js';

for (const kind of ['memory', 'sqlite'] as const) {
  it(`${kind}: renderedUpTo zero cards evidence and delivers exactly one gated fixed closure`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    interrupt(h, 0);
    const settled = h.state.domain.deliveries[delivery.id]!;
    expect(settled.promiseWitness).toBe('evidence_incomplete');
    expect(settled.claimsDelivered).toEqual([]);
    expect(recentTurns(h.state.domain, 20).some(turn => turn.id === delivery.id)).toBe(false);
    expect(closureCandidates(h)).toHaveLength(0);
    finishFixedClosure(h, candidate.jobId!);
    expect(h.state.domain.initiative.candidates[candidate.id]?.state).toBe('card_only');
    h.store.close();
  });

  it(`${kind}: renderedUpTo five preserves the word prefix but still delivers a fixed closure`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    interrupt(h, 5);
    const settled = h.state.domain.deliveries[delivery.id]!;
    expect(settled.interruptedPrefix).toBe('Edits');
    expect(settled.promiseWitness).toBe('evidence_incomplete');
    expect(settled.claimsDelivered).toEqual([]);
    finishFixedClosure(h, candidate.jobId!);
    h.store.close();
  });

  it(`${kind}: the full nineteen-character claim closes the promise without a fixed line`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    expect(delivery.sentChars).toBe(19);
    interrupt(h, 19);
    h.interpret();
    h.passReply();
    const settled = h.state.domain.deliveries[delivery.id]!;
    expect(settled.promiseWitness).toBe('evidence_rendered');
    expect(settled.claimsDelivered).toHaveLength(1);
    expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
    expect(closureCandidates(h)).toHaveLength(0);
    h.store.close();
  });

  it(`${kind}: only sending the first sentence of a multi-sentence claim does not close it`, () => {
    const { h, candidate, delivery } = startEvidence(kind, true);
    expect(delivery.chunks.map(chunk => chunk.state)).toEqual(['sent', 'pending']);
    interrupt(h, firstClaim.length + 1);
    expect(h.state.domain.deliveries[delivery.id]?.claimsDelivered).toEqual([]);
    finishFixedClosure(h, candidate.jobId!);
    h.store.close();
  });

  it(`${kind}: a complete first verified claim closes even when the second claim was never sent`, () => {
    const { h, candidate, delivery } = startEvidence(kind, true, true);
    interrupt(h, firstClaim.length);
    h.interpret();
    h.passReply();
    expect(h.state.domain.deliveries[delivery.id]?.claimsDelivered).toHaveLength(1);
    expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_rendered');
    expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
    expect(closureCandidates(h)).toHaveLength(0);
    h.store.close();
  });

  it(`${kind}: an uncertain disconnect closes conservatively without re-speaking`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    h.send('client.disconnected', {});
    const settled = h.state.domain.deliveries[delivery.id]!;
    expect(settled.promiseWitness).toBe('evidence_uncertain');
    expect(settled.renderedOffsetKnown).not.toBe(true);
    expect(settled.claimsDelivered).toEqual([]);
    expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
    h.connect();
    h.timer('floorGap');
    expect(closureCandidates(h)).toHaveLength(0);
    expect(h.effects.filter(effect => effect.type === 'client.send'
      && effect.message.type === 'assistant.chunk')).toHaveLength(1);
    h.store.close();
  });

  it(`${kind}: uncertain recovery persists its witness and starts no delivery or model work`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    const recovery = h.send('session.recovered', {});
    const settled = h.store.loadSnapshot('s')!.state.domain.deliveries[delivery.id]!;
    expect(DeliverySchema.parse(JSON.parse(JSON.stringify(settled))).promiseWitness).toBe('evidence_uncertain');
    expect(recovery.effects.some(effect => effect.type === 'llm.call' || effect.type === 'job.dispatch'
      || (effect.type === 'client.send' && effect.message.type === 'assistant.chunk'))).toBe(false);
    expect(h.state.domain.jobs[candidate.jobId!]?.closureCount).toBe(1);
    h.connect();
    h.timer('floorGap');
    expect(closureCandidates(h)).toHaveLength(0);
    h.store.close();
  });

  it(`${kind}: an explicit zero acknowledgment remains known on disconnect`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    h.send('delivery.progress', {
      deliveryId: delivery.id,
      chunkIdx: 0,
      chars: 0,
      final: false,
      reason: 'rendered',
    });
    h.send('client.disconnected', {});
    expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_incomplete');
    expect(closureCandidates(h)).toHaveLength(1);
    h.connect();
    interrupt(h);
    finishFixedClosure(h, candidate.jobId!);
    h.store.close();
  });

  it(`${kind}: a partial acknowledgment remains known on recovery`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    h.send('delivery.progress', {
      deliveryId: delivery.id,
      chunkIdx: 0,
      chars: 5,
      final: false,
      reason: 'rendered',
    });
    const recovered = h.send('session.recovered', {});
    expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_incomplete');
    expect(closureCandidates(h)[0]?.state).toBe('candidate');
    expect(recovered.effects.some(effect => effect.type === 'client.send'
      && effect.message.type === 'assistant.chunk')).toBe(false);
    h.connect();
    interrupt(h);
    finishFixedClosure(h, candidate.jobId!);
    h.store.close();
  });

  it(`${kind}: the commit offset reconciles an earlier uncertain composer interruption`, () => {
    const { h, candidate, delivery } = startEvidence(kind);
    h.send('input.activity', { channel: 'composer', active: true });
    expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_uncertain');
    interrupt(h, 0);
    expect(h.state.domain.deliveries[delivery.id]?.promiseWitness).toBe('evidence_incomplete');
    finishFixedClosure(h, candidate.jobId!);
    h.store.close();
  });
}

it('the promise invariant refuses a sent-but-unrendered evidence closure count', () => {
  const { h, candidate } = startEvidence('memory');
  const after = structuredClone(h.state);
  after.domain.jobs[candidate.jobId!]!.closureCount = 1;
  const event = EventSchema.parse({
    type: 'client.disconnected',
    eventId: 'probe',
    sessionId: 's',
    payload: {},
  });
  expect(promised_closed_once(h.state, event, after, [], []))
    .toContain(`promised_closed_once: witness count differs: ${candidate.jobId}`);
  h.store.close();
});
