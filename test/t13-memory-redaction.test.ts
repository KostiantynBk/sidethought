import { describe, expect, it } from 'vitest';
import type { Delivery } from '../src/contract/index.js';
import { assembleWithLessons } from '../src/memory/context.js';
import { REDUCER_VERSION } from '../src/runtime/session-runner.js';
import { memorySetup, modelState } from './t13-memory-helpers.js';

function delivered(id: string, callId: string, text: string): Delivery {
  return {
    id,
    callId,
    basisRev: 0,
    state: 'delivered',
    chunks: [{ text, state: 'rendered', claimIds: [], sentenceFinished: true }],
    deliveredChars: text.length,
    sentChars: text.length,
    finalAcknowledged: true,
    aborted: false,
    settled: true,
    claimsDelivered: [],
  };
}

function usedLesson() {
  const test = memorySetup();
  test.memory.setEnabled(test.target.id, true);
  const { state, effect } = modelState(test.target.id);
  const id = test.target.id;
  state.meta.seq = 10;
  state.domain.reply!.buffer = 'amber-canary unsent private suffix';
  state.domain.call!.quoteWitness.recent = [{ id: 'earlier', role: 'assistant', text: test.lesson.text }];
  state.domain.deliveries.before = delivered(`${id}.2.3`, `${id}.2.2`, 'Earlier unrelated answer.');
  state.domain.deliveries.direct = delivered(`${id}.3.3`, effect.callId, test.lesson.text);
  state.domain.deliveries.indirect = delivered(`${id}.6.3`, `${id}.6.2`, 'amber-canary indirect reuse.');
  test.store.commit(id, [{
    sessionId: id,
    seq: 4,
    eventId: 'recorded-chunk',
    type: 'reply.chunk',
    acceptedAt: 4,
    payload: { requestId: effect.requestId, callId: effect.callId, text: test.lesson.text },
  }, {
    sessionId: id,
    seq: 8,
    eventId: 'recorded-interpretation',
    type: 'interpretation.ready',
    acceptedAt: 8,
    payload: {
      requestId: 'later',
      callId: `${id}.8.1`,
      output: {
        inputKinds: [],
        ops: [{ op: 'create', kind: 'option', status: 'proposed', text: test.lesson.text, quoteSpans: [] }],
        replacementGroups: [],
        researchRequests: [],
        deprioritizedTopics: [],
        voiceConfirmValues: [],
      },
    },
  }], { seq: 10, reducerVersion: REDUCER_VERSION, state });
  test.memory.recordUse(effect.callId, id, [test.lesson]);
  return { ...test, state, effect };
}

describe('shared lesson removal and correction', () => {
  it('purges direct and later indirect assistant context and model-output journal content', () => {
    const { store, memory, target, lesson } = usedLesson();
    expect(memory.removeLesson(lesson.id, 1)).toEqual([target.id]);
    const snapshot = store.loadSnapshot(target.id)!;
    const text = JSON.stringify(snapshot.state);
    expect(text).not.toContain('amber-canary');
    expect(text).toContain('Earlier unrelated answer.');
    expect(text).toContain('Reply removed after a shared lesson changed');
    expect(JSON.stringify(store.readJournal(target.id))).not.toContain('amber-canary');
    expect(memory.recentUses(target.id)).toEqual([]);
    expect(memory.lessons()).toEqual([]);
    expect(memory.retrieve(target.id, 'forecasting')).toEqual([]);
    expect(memory.inputs(target.id)[0]!.text).toContain('forecasting');
    expect(memory.inputs('local')[0]!.text).toContain('amber-canary');
  });

  it('redacts the old version before allowing the corrected lesson into later calls', () => {
    const { store, memory, target, lesson } = usedLesson();
    const result = memory.changeLesson(lesson.id, {
      text: 'Corrected: a short pilot run is now sufficient.',
      terms: ['forecasting'],
      expectedVersion: 1,
      acknowledgeRedaction: true,
    });
    expect(result.affected).toEqual([target.id]);
    expect(result.lesson.version).toBe(2);
    expect(JSON.stringify(store.loadSnapshot(target.id))).not.toContain('amber-canary');
    const { state, effect } = modelState(target.id);
    const input = JSON.parse(assembleWithLessons(memory, state, effect).input);
    expect(input.reusableLessons[0].lesson).toBe(result.lesson.text);
    expect(input.reusableLessons[0].version).toBe(2);
    // The unchanged exact source quote remains inspectable provenance, not the revised lesson.
    expect(input.reusableLessons[0].sourceQuote).toBe(lesson.quote);
  });
});
