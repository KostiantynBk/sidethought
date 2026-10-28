import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { config, parse, readyOutput } from './t03-helpers.js';

const s1Text = 'An offline-first note app for freelancers. Provider A might handle sync; '
  + 'I need to know if its client works without a network.';

function commit(state: State, eventId: string, message: string, at: number): State {
  return reduce(state, parse({
    eventId,
    sessionId: 's',
    acceptedAt: at,
    type: 'input.committed',
    payload: {
      clientMsgId: eventId,
      text: message,
      modality: 'text',
    },
  })).state;
}

function fixture(name: string, inputId: string): Record<string, unknown> {
  const source = readFileSync(`fixtures/t06/${name}.json`, 'utf8');
  return JSON.parse(source.replaceAll('$INPUT', inputId)) as Record<string, unknown>;
}

function ready(state: State, output: object) {
  const call = state.domain.call!;
  return reduce(state, parse({
    eventId: 'ready',
    sessionId: 's',
    acceptedAt: 1100,
    type: 'interpretation.ready',
    payload: {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: call.inputIds.map(inputId => ({
          inputId,
          kind: 'statement',
        })),
        ...output,
      },
    },
  }));
}

it('S1 t=1.1 binds a promised request to an option created in the same output', () => {
  const state = commit(initialState('s', config), 'm1', s1Text, 0);
  expect(state.domain.items).toEqual({});
  const result = ready(state, fixture('s1-create-and-request', state.domain.inputs[0]!.id));
  const items = Object.values(result.state.domain.items);
  const requirement = items.find(item => item.text === 'offline-first note app for freelancers');
  const option = items.find(item => item.text === 'Provider A for sync');
  expect(requirement?.status).toBe('stated');
  expect(option?.status).toBe('considering');
  expect(option?.contentVersion).toBe(1);
  expect(result.state.domain.projectRev).toBe(1);
  expect(result.state.domain.pendingRequests).toHaveLength(1);
  expect(result.state.domain.pendingRequests[0]).toMatchObject({
    inputId: state.domain.inputs[0]!.id,
    question: "Does Provider A's client work without a network connection?",
    publicQuery: 'Provider A client offline support',
    promised: true,
    deps: [{
        itemId: option!.id,
        contentVersion: 1,
      }],
  });
  expect(result.effects.some(effect => effect.type === 'llm.call')).toBe(false);
});

it('keeps only the configured number of research requests per input', () => {
  const limitedConfig = {
    ...config,
    maxResearchRequestsPerInput: 1,
  };
  const state = commit(initialState('s', limitedConfig), 'm1', s1Text, 0);
  const inputId = state.domain.inputs[0]!.id;
  const output = fixture('s1-create-and-request', inputId);
  const request = {
    inputId,
    question: 'Is synchronization secure?',
    publicQuery: 'Provider A sync security',
    depItemIds: ['new:1'],
  };
  const first = (output.researchRequests as object[])[0]!;
  const result = ready(state, {
    ...output,
    researchRequests: [first, request],
  });
  expect(result.state.domain.pendingRequests).toHaveLength(1);
  expect(result.state.domain.pendingRequests[0]?.question)
    .toBe("Does Provider A's client work without a network connection?");
  expect(result.decisions.map(decision => decision.reason)).toContain('research:over_limit');
  expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
});

it('retries a research request attributed to an input outside the current batch', () => {
  const state = commit(initialState('s', config), 'm1', s1Text, 0);
  const queued = commit(state, 'm2', 'Check sync security.', 1);
  const call = queued.domain.call!;
  const result = ready(queued, fixture('outside-batch-request', queued.domain.inputs[1]!.id));
  expect(result.state.domain.pendingRequests).toEqual([]);
  expect(result.state.domain.items).toEqual({});
  expect(result.state.domain.call?.requestId).toBe(call.requestId);
  expect(result.state.domain.call?.callId).not.toBe(call.callId);
  expect(result.state.domain.call?.attempt).toBe(2);
});

it('retries the whole output when a quote does not match its input', () => {
  const state = commit(initialState('s', config), 'm1', s1Text, 0);
  const call = state.domain.call!;
  const result = ready(state, fixture('span-mismatch', state.domain.inputs[0]!.id));
  expect(result.state.domain.items).toEqual({});
  expect(result.decisions.map(decision => decision.reason)).toContain('span:mismatch');
  expect(result.state.domain.call?.requestId).toBe(call.requestId);
  expect(result.state.domain.call?.callId).not.toBe(call.callId);
  expect(result.state.domain.call?.attempt).toBe(2);
});
