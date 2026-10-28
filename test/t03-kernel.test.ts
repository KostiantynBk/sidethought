import { describe, expect, it } from 'vitest';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { invariantRegistry } from '../src/harness/index.js';
import { commit, config, parse, readyOutput } from './t03-helpers.js';

function deepFreeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

function resultEvent(type: 'interpretation.ready' | 'interpretation.failed', callId: string, requestId: string) {
  return parse({
    eventId: `result-${type}-${callId}`,
    sessionId: 's',
    acceptedAt: 5,
    type,
    payload: type === 'interpretation.ready'
      ? {
        requestId,
        callId,
        output: readyOutput,
      }
      : {
        requestId,
        callId,
        reason: 'failed',
      },
  });
}

function checkInert(before: State, result: ReturnType<typeof reduce>, reason: string): void {
  expect(result.state.domain).toEqual(before.domain);
  expect(result.state.meta.seq).toBe(before.meta.seq + 1);
  expect(result.effects).toEqual([]);
  expect(result.decisions).toEqual([{
    seq: before.meta.seq + 1,
    kind: 'kernel',
    reason,
  }]);
}

function retryState() {
  const initial = reduce(initialState('s', config), commit('e', 'm', 0));
  const first = initial.state.domain.call!;
  const retry = reduce(initial.state, resultEvent('interpretation.failed', first.callId, first.requestId));
  return {
    first,
    retry,
  };
}

describe('kernel boundaries', () => {
  it('does not mutate frozen state and deduplicates event IDs', () => {
    const state = initialState('s', config);
    deepFreeze(state);
    const event = commit('e', 'm', 0);
    const first = reduce(state, event);
    deepFreeze(first.state);
    const duplicate = reduce(first.state, event);
    checkInert(first.state, duplicate, 'dup:eventId');
  });

  it('deduplicates clientMsgId separately from eventId', () => {
    const first = reduce(initialState('s', config), commit('e', 'm', 0));
    const duplicate = reduce(first.state, commit('different-event', 'm', 1));
    checkInert(first.state, duplicate, 'dup:clientMsgId');
  });

  it.each(['interpretation.ready', 'interpretation.failed'] as const)(
    'ignores a late %s from a retired attempt',
    type => {
      const { first, retry } = retryState();
      const event = resultEvent(type, first.callId, first.requestId);
      const late = reduce(retry.state, {
        ...event,
        eventId: 'late-result',
      });
      checkInert(retry.state, late, 'late:retired_attempt');
    },
  );

  it('retains captured item versions across an edit, retry and result', () => {
    const state = initialState('s', config);
    state.domain.items = { item: {
      id: 'item',
      kind: 'name',
      status: 'stated',
      text: 'old',
      contentVersion: 6,
      private: false,
      provenance: {
        origin: 'user',
        quoteSpans: [],
      },
      voiceConfirmNeeded: false,
    } };
    const dispatched = reduce(state, commit('e', 'm', 0));
    const first = dispatched.state.domain.call!;
    expect(first.capturedInputs).toEqual([{
      itemId: 'item',
      contentVersion: 6,
    }]);
    const changed = structuredClone(dispatched.state);
    changed.domain.items['item']!.contentVersion = 7;
    const failure = resultEvent('interpretation.failed', first.callId, first.requestId);
    const retry = reduce(changed, failure);
    expect(retry.state.domain.call?.capturedInputs).toEqual([{
      itemId: 'item',
      contentVersion: 6,
    }]);
    expect(retry.effects[0]).toMatchObject({ capturedInputs: [{
      itemId: 'item',
      contentVersion: 6,
    }] });
    const current = retry.state.domain.call!;
    const ready = resultEvent('interpretation.ready', current.callId, current.requestId);
    expect(current.capturedInputs).toEqual([{
      itemId: 'item',
      contentVersion: 6,
    }]);
    const result = reduce(retry.state, ready);
    expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
    expect(result.state.domain.items['item']?.contentVersion).toBe(7);
    expect(result.effects).toEqual([]);
  });

  it('marks inputs needs_retry after the second failure', () => {
    const { retry } = retryState();
    const current = retry.state.domain.call!;
    const failure = resultEvent('interpretation.failed', current.callId, current.requestId);
    const result = reduce(retry.state, failure);
    expect(result.state.domain.inputs[0]?.status).toBe('needs_retry');
    expect(result.state.domain.call).toBeNull();
  });

  it('ignores a superseded timer', () => {
    const first = reduce(initialState('s', config), commit('e', 'm', 0));
    const oldTimer = first.state.domain.timers[0]!;
    const second = reduce(first.state, commit('e2', 'm2', 1));
    const event = parse({
      eventId: 'timer',
      sessionId: 's',
      acceptedAt: 800,
      type: 'timer.fired',
      payload: {
        timerId: oldTimer.timerId,
        purpose: oldTimer.purpose,
      },
    });
    const stale = reduce(second.state, event);
    checkInert(second.state, stale, 'stale:timer');
  });
});

describe('invariant registry negative tests', () => {
  it('rejects a missing sequence increment and extra decision', () => {
    const event = commit('e', 'm', 0);
    const first = reduce(initialState('s', config), event);
    const valid = reduce(first.state, event);
    const bad = structuredClone(valid);
    bad.state.meta.seq = first.state.meta.seq;
    bad.decisions.push({
      seq: bad.state.meta.seq,
      kind: 'kernel',
      reason: 'extra',
    });
    const errors = invariantRegistry.flatMap(check =>
      check(first.state, event, bad.state, bad.effects, bad.decisions),
    );
    expect(errors).toContain('sequence must advance exactly once');
    expect(errors.some(error => error.startsWith('I6'))).toBe(true);
  });

  it('rejects wrong duplicate reason and sequence', () => {
    const event = commit('e', 'm', 0);
    const first = reduce(initialState('s', config), event);
    const valid = reduce(first.state, event);
    const badDecisions = [{
      seq: 999,
      kind: 'kernel',
      reason: 'dup:clientMsgId',
    }];
    const errors = invariantRegistry.flatMap(check =>
      check(first.state, event, valid.state, valid.effects, badDecisions),
    );
    expect(errors.some(error => error.startsWith('I6'))).toBe(true);
  });

  it('rejects a retired result with a fabricated extra decision', () => {
    const { first, retry } = retryState();
    const event = resultEvent('interpretation.ready', first.callId, first.requestId);
    const valid = reduce(retry.state, event);
    const badDecisions = [...valid.decisions, valid.decisions[0]!];
    const errors = invariantRegistry.flatMap(check =>
      check(retry.state, event, valid.state, valid.effects, badDecisions),
    );
    expect(errors.some(error => error.startsWith('I18'))).toBe(true);
  });
});
