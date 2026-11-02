import { expect, it } from 'vitest';
import { assembleContext, type CallEffect } from '../src/context/index.js';
import { DevModel } from '../src/runtime/dev-model.js';
import type { RawEvent } from '../src/runtime/model-port.js';
import { ContributionHarness, scores } from './t12a-helpers.js';

function devCheck(h: ContributionHarness) {
  const candidate = Object.values(h.state.domain.initiative.candidates).find(value => value.state === 'checking')!;
  expect(candidate).toBeDefined();
  const check = candidate.check!;
  const effect: CallEffect = {
    type: 'llm.call',
    role: 'checker',
    requestId: check.requestId,
    callId: check.callId,
    basisRev: check.basisRev,
    capturedInputs: check.capturedInputs,
  };
  const payload = JSON.parse(assembleContext(h.state, effect).input).candidate;
  const events: RawEvent[] = [];
  new DevModel().handle(effect, { state: h.state, emit: event => { events.push(event); } });
  expect(events[0]?.type).toBe('check.ready');
  const output = (events[0]!.payload as {
    output: { applies: boolean; utterance: string; claimsUsed: string[] };
  }).output;
  return { output, payload };
}

it('dev Checker copies the first verified evidence claim and its ID', () => {
  const h = new ContributionHarness('memory');
  try {
    h.connect();
    h.request();
    h.passReply();
    h.at += 3000;
    h.complete();
    const { output, payload } = devCheck(h);
    expect(output.applies).toBe(true);
    expect(output.utterance).toBe(payload.claims[0].text);
    expect(output.claimsUsed).toEqual([payload.claims[0].id]);
  } finally {
    h.store.close();
  }
});

it('dev Checker copies the clarification question without claiming evidence', () => {
  const h = new ContributionHarness('memory', {}, []);
  try {
    h.connect();
    const itemId = h.statement('Use local notes.');
    h.passReply();
    h.nominate([{
      kind: 'clarification',
      topic: 'local notes',
      question: 'Should notes remain local?',
      depItemIds: [itemId],
      scores: { ...scores, consequence: 3 },
    }]);
    h.timer('floorGap');
    const { output, payload } = devCheck(h);
    expect(output.applies).toBe(true);
    expect(output.utterance).toBe(payload.text);
    expect(output.claimsUsed).toEqual([]);
  } finally {
    h.store.close();
  }
});
