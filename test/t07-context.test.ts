import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { assembleContext, type CallEffect } from '../src/context/index.js';
import { recentTurns } from '../src/context/recent.js';
import { deliveredContextInvariant } from '../src/harness/context-invariant.js';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { parse } from './t03-helpers.js';
import { commit, fire, replyResult, streaming } from './t07-helpers.js';
import { interrupt, sent } from './t07-abort-helpers.js';

function effect(state: State): CallEffect {
  const call = state.domain.reply!;
  return {
    type: 'llm.call',
    role: 'responder',
    requestId: call.requestId,
    callId: call.callId,
    basisRev: call.basisRev,
    capturedInputs: call.capturedInputs,
  };
}

it('assembles ordered JSON sections and stable version-tagged Responder instructions', () => {
  const state = streaming();
  const prompt = assembleContext(state, effect(state));
  const input = JSON.parse(prompt.input);
  expect(Object.keys(input)).toEqual(['projectSnapshot', 'researchState', 'recentWindow', 'task']);
  expect(input.projectSnapshot.revision).toBe('r0');
  expect(input.researchState).toEqual({
    jobs: [],
    findings: [],
  });
  expect(prompt.instructions).toContain('[sidethought-responder-v1]');
  expect(prompt.instructions).toContain('[sidethought-output-rules-v1]');
  expect(prompt.instructions).toContain('[PASS]');
});

it('includes exactly captured item versions, preserving private flags for reasoning', () => {
  const state = streaming();
  const item = {
    id: 'private-item',
    kind: 'requirement' as const,
    status: 'stated' as const,
    text: 'Private product detail',
    contentVersion: 2,
    private: true,
    provenance: {
      origin: 'user' as const,
      quoteSpans: [],
    },
    voiceConfirmNeeded: false,
  };
  state.domain.items[item.id] = item;
  state.domain.items.excluded = {
    ...item,
    id: 'excluded',
    text: 'Not captured',
  };
  const dispatch = effect(state);
  dispatch.capturedInputs = [{
    itemId: item.id,
    contentVersion: 2,
  }];
  const input = JSON.parse(assembleContext(state, dispatch).input);
  expect(input.projectSnapshot.items).toHaveLength(1);
  expect(input.projectSnapshot.items[0]).toMatchObject({
    id: item.id,
    private: true,
    contentVersion: 2,
  });
  expect(assembleContext(state, dispatch).input).not.toContain('Not captured');
  state.domain.items[item.id]!.contentVersion = 3;
  expect(() => assembleContext(state, dispatch)).toThrow('context:capture_mismatch');
  delete state.domain.items[item.id];
  expect(() => assembleContext(state, dispatch)).toThrow('context:capture_mismatch');
});

it('rejects duplicate captures rather than silently deduplicating them', () => {
  const state = streaming();
  const dispatch = effect(state);
  dispatch.capturedInputs = [{
    itemId: 'missing',
    contentVersion: 1,
  }];
  expect(() => assembleContext(state, dispatch)).toThrow('context:capture_mismatch');
});

it('marks the soft-wait inputs as overriding the snapshot', () => {
  const pending = commit(initialState('s', loadConfig())).state;
  const waiting = fire(pending, 'replyDebounce').state;
  const state = fire(waiting, 'interpreterSoftWait').state;
  const input = JSON.parse(assembleContext(state, effect(state)).input);
  expect(input.task.inputs[0].note).toBe('not yet in project state; it overrides the snapshot');
});

it('shows only the whole-word delivered interruption prefix to the next Interpreter', () => {
  const result = interrupt(sent('Provider B costs $12 per month. '), 18);
  const dispatch = result.effects.find(item => item.type === 'llm.call') as CallEffect;
  const prompt = assembleContext(result.state, dispatch);
  const input = JSON.parse(prompt.input);
  expect(prompt.instructions).toContain('[sidethought-interpreter-v1]');
  expect(prompt.instructions).toContain('quote is the authoritative exact source wording');
  expect(input.recentWindow.map((turn: { text: string }) => turn.text)).toEqual([
    'Use local storage.',
    '[interrupted after: Provider B costs]',
    'Actually no cloud.',
  ]);
  expect(prompt.input).not.toContain('$12');
  expect(prompt.input).not.toContain('per month');
});

it('excludes sent but unacknowledged text, reply buffers and assistant-origin input storage', () => {
  const state = replyResult(streaming(), 'reply.chunk', 'Unacknowledged sentence. Unsent buffer').state;
  state.domain.inputs.push({
    id: 'legacy-assistant',
    origin: 'assistant',
    status: 'interpreted',
    text: 'Legacy unverified assistant text',
  });
  const prompt = assembleContext(state, effect(state));
  expect(prompt.input).not.toContain('Unacknowledged');
  expect(prompt.input).not.toContain('Unsent');
  expect(prompt.input).not.toContain('Legacy unverified');
});

it('uses the latest K turns in sequence order rather than the earliest page', () => {
  const result = interrupt(sent('First sentence. '), 16);
  expect(recentTurns(result.state.domain, 2).map(turn => turn.role)).toEqual(['assistant', 'user']);
  expect(recentTurns(result.state.domain, 1)[0]?.text).toBe('Actually no cloud.');
});

it('does not include historical inputs in the new Responder task after multiple generations', () => {
  let state = streaming();
  for (const id of ['second', 'third']) {
    state = replyResult(state, 'reply.done').state;
    state = commit(state, 3000, id).state;
    state = fire(fire(state, 'replyDebounce').state, 'interpreterSoftWait').state;
  }
  const input = JSON.parse(assembleContext(state, effect(state)).input);
  expect(input.task.inputs).toHaveLength(2); // Both outstanding inputs override the snapshot.
  expect(input.task.inputs.some((value: { id: string }) => value.id === 's.1.1')).toBe(false);
});

it('detects an injected undelivered interrupted marker through the I9 registry function', () => {
  const result = interrupt(sent(), 10);
  const state = structuredClone(result.state);
  state.domain.deliveries[Object.keys(state.domain.deliveries)[0]!]!.interruptedPrefix = 'Injected unseen tail';
  const event = parse({
    eventId: 'probe',
    sessionId: 's',
    acceptedAt: 2001,
    type: 'client.disconnected',
    payload: {},
  });
  expect(deliveredContextInvariant(result.state, event, state, [])).toContain(
    'I9 interrupted marker contains undelivered text',
  );
});

it('detects a claim marked delivered before its sentence finished', () => {
  const state = sent();
  const delivery = state.domain.deliveries[state.domain.reply!.deliveryId]!;
  delivery.chunks[0]!.claimIds = ['price'];
  delivery.claimsDelivered = ['price'];
  const event = parse({
    eventId: 'probe',
    sessionId: 's',
    acceptedAt: 2001,
    type: 'client.disconnected',
    payload: {},
  });
  expect(deliveredContextInvariant(state, event, state, [])).toContain(
    'I9 claim accounting differs from completed delivered sentences',
  );
});

it('bounds the recent window from one through one hundred turns', () => {
  expect(loadConfig().recentWindowTurns).toBe(20);
  expect(loadConfig({ recentWindowTurns: 1 }).recentWindowTurns).toBe(1);
  expect(loadConfig({ recentWindowTurns: 100 }).recentWindowTurns).toBe(100);
  expect(() => loadConfig({ recentWindowTurns: 0 })).toThrow();
  expect(() => loadConfig({ recentWindowTurns: 101 })).toThrow();
  expect(() => loadConfig({ recentWindowTurns: 1.5 })).toThrow();
});

it('includes the current clarification and deprioritized topics without pending research results', () => {
  const state = streaming();
  state.domain.clarifications.push({
    inputIds: state.domain.reply!.inputIds,
    clarification: 'Is offline setup essential?',
  });
  state.domain.deprioritizedTopics = ['naming'];
  const input = JSON.parse(assembleContext(state, effect(state)).input);
  expect(input.task.clarification).toBe('Is offline setup essential?');
  expect(input.projectSnapshot.deprioritizedTopics).toEqual(['naming']);
  expect(input.researchState.jobs).toEqual([]);
});
