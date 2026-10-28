import { readFileSync } from 'node:fs';
import type { Item } from '../src/contract/index.js';
import { initialState, reduce, type State } from '../src/kernel/index.js';
import { config, parse, readyOutput } from './t03-helpers.js';

const text = 'Use local storage. Never use cloud.';
const item = (id: string, value: string): Item => ({
  id,
  kind: 'requirement',
  status: 'stated',
  text: value,
  contentVersion: 1,
  private: false,
  provenance: {
    origin: 'user',
    quoteSpans: [],
  },
  voiceConfirmNeeded: false,
});

export function start(): State {
  const state = initialState('s', config);
  state.domain.items.r1 = item('r1', 'Use cloud');
  state.domain.items.r2 = item('r2', 'Use remote backup');
  return reduce(state, parse({
    eventId: 'input',
    sessionId: 's',
    acceptedAt: 0,
    type: 'input.committed',
    payload: {
      clientMsgId: 'm1',
      text,
      modality: 'text',
    },
  })).state;
}

export function fixture(name: string, inputId: string): Record<string, unknown> {
  const source = readFileSync(`fixtures/t06/${name}.json`, 'utf8');
  return JSON.parse(source.replaceAll('$INPUT', inputId)) as Record<string, unknown>;
}

export function ready(state: State, output: object, eventId = 'ready') {
  const call = state.domain.call!;
  return reduce(state, parse({
    eventId,
    sessionId: 's',
    acceptedAt: 10,
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

export function edit(state: State, eventId: string, version: number, value: string): State {
  return reduce(state, parse({
    eventId,
    sessionId: 's',
    acceptedAt: 5,
    type: 'item.action',
    payload: {
      itemId: 'r1',
      expectedVersion: version,
      action: 'edit',
      text: value,
    },
  })).state;
}

export const reasons = (result: ReturnType<typeof ready>) => result.decisions.map(decision => decision.reason);

