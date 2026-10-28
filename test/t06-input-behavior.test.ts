import { describe, expect, it } from 'vitest';
import { hasUninterpretedInput, initialState, reduce } from '../src/kernel/index.js';
import { config, parse } from './t03-helpers.js';
import { fixture, ready, reasons, start } from './t06-patch-helpers.js';

describe('T06 input behavior fixtures', () => {
  it('records two promised requests with captured and newly created dependency versions', () => {
    const state = start();
    const result = ready(state, fixture('v1g-two-requests', state.domain.inputs[0]!.id));
    const created = Object.values(result.state.domain.items).find(value => value.text === 'Use local storage');
    expect(created).toBeDefined();
    const requests = result.state.domain.pendingRequests;
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.promised)).toBe(true);
    expect(requests[0]?.deps).toEqual([{
      itemId: created!.id,
      contentVersion: 1,
    }]);
    expect(requests[1]?.deps).toEqual([
      {
        itemId: 'r1',
        contentVersion: 1,
      },
      {
        itemId: created!.id,
        contentVersion: 1,
      },
    ]);
    expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
    expect(hasUninterpretedInput(result.state)).toBe(false);
  });

  it('keeps a promised request when its referenced create is rejected', () => {
    const state = start();
    const result = ready(state, fixture('rejected-create-dependency', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(state.domain.items);
    expect(result.state.domain.pendingRequests).toHaveLength(1);
    expect(result.state.domain.pendingRequests[0]?.promised).toBe(true);
    expect(result.state.domain.pendingRequests[0]?.deps).toEqual([]);
    expect(reasons(result)).toContain('research:dep_dropped');
  });

  it('interprets a queued correction against the item produced by the first single-flight call', () => {
    const first = start();
    const queued = reduce(first, parse({
      eventId: 'second-input',
      sessionId: 's',
      acceptedAt: 1,
      type: 'input.committed',
      payload: {
        clientMsgId: 'm2',
        text: 'Never use cloud.',
        modality: 'text',
      },
    })).state;
    expect(queued.domain.call?.callId).toBe(first.domain.call?.callId);
    const output = fixture('v1g-two-requests', first.domain.inputs[0]!.id);
    const afterFirst = ready(queued, output).state;
    const created = Object.values(afterFirst.domain.items).find(value => value.text === 'Use local storage');
    expect(created).toBeDefined();
    expect(afterFirst.domain.call?.inputIds).toEqual([afterFirst.domain.inputs[1]!.id]);
    expect(afterFirst.domain.call?.capturedInputs).toContainEqual({
      itemId: created!.id,
      contentVersion: 1,
    });
    const correction = JSON.parse(JSON.stringify(fixture('s3c-self-correction', afterFirst.domain.inputs[1]!.id))
      .replaceAll('$TARGET', created!.id)) as object;
    const result = ready(afterFirst, correction, 'correction');
    expect(result.state.domain.items[created!.id]?.status).toBe('retracted');
    expect(result.state.domain.inputs[1]?.status).toBe('interpreted');
  });

  it('stores clarification while preserving a multi-input hedge as considering', () => {
    const state = initialState('s', config);
    state.domain.inputs.push({
      id: 'a',
      text: 'I was thinking ten euros a month.',
      status: 'interpreted',
      origin: 'user',
    });
    const committed = reduce(state, parse({
      eventId: 'price-input',
      sessionId: 's',
      acceptedAt: 0,
      type: 'input.committed',
      payload: {
        clientMsgId: 'price-message',
        text: 'What customers pay.',
        modality: 'text',
      },
    })).state;
    const inputId = committed.domain.inputs[1]!.id;
    const result = ready(committed, fixture('s5-clarify', inputId));
    const price = Object.values(result.state.domain.items)
      .find(value => value.text === 'customer price: €10 per month');
    expect(price?.status).toBe('considering');
    expect(result.state.domain.clarifications).toContainEqual({
      inputIds: [inputId],
      clarification: 'What should customers pay?',
    });
    expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
  });

  it('sets a wait timer and clears userWait on the next committed input', () => {
    const state = start();
    const result = ready(state, fixture('v2f-wait', state.domain.inputs[0]!.id));
    expect(result.state.domain.userWait).toBe(true);
    expect(result.state.domain.replyPending).toBe(false);
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'timer.set',
      purpose: 'userWait',
    }));
    const next = reduce(result.state, parse({
      eventId: 'next',
      sessionId: 's',
      acceptedAt: 20,
      type: 'input.committed',
      payload: {
        clientMsgId: 'm2',
        text: 'Continue.',
        modality: 'text',
      },
    }));
    expect(next.state.domain.userWait).toBe(false);
    expect(hasUninterpretedInput(next.state)).toBe(true);
  });

  it('clears userWait and its timer on active composer activity', () => {
    const state = start();
    const waited = ready(state, fixture('v2f-wait', state.domain.inputs[0]!.id)).state;
    const timer = waited.domain.timers.find(value => value.purpose === 'userWait')!;
    const result = reduce(waited, parse({
      eventId: 'active',
      sessionId: 's',
      acceptedAt: 20,
      type: 'input.activity',
      payload: {
        channel: 'composer',
        active: true,
      },
    }));
    expect(result.state.domain.userWait).toBe(false);
    expect(result.state.domain.timers.some(value => value.timerId === timer.timerId)).toBe(false);
    expect(result.effects).toContainEqual({
      type: 'timer.clear',
      timerId: timer.timerId,
    });
  });

  it('clears userWait when its timer fires', () => {
    const state = start();
    const waited = ready(state, fixture('v2f-wait', state.domain.inputs[0]!.id)).state;
    const timer = waited.domain.timers.find(value => value.purpose === 'userWait')!;
    const result = reduce(waited, parse({
      eventId: 'wait-fired',
      sessionId: 's',
      acceptedAt: timer.dueAt,
      type: 'timer.fired',
      payload: {
        timerId: timer.timerId,
        purpose: 'userWait',
      },
    }));
    expect(result.state.domain.userWait).toBe(false);
    expect(result.state.domain.timers.some(value => value.timerId === timer.timerId)).toBe(false);
  });
});
