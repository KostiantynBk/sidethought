import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { Delivery } from '../src/contract/index.js';
import { researchContext } from '../src/context/research.js';
import { verifiedFindingUrls } from '../src/kernel/research/findings.js';
import { outputFailure } from '../src/kernel/reply-output.js';
import { assembleWithLessons } from '../src/memory/context.js';
import { REDUCER_VERSION, SessionRunner } from '../src/runtime/session-runner.js';
import { ResearchHarness, claims, evidence, url } from './t11a-helpers.js';
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

  it.each(['edit', 'forget'] as const)(
    'purges item-derived research on lesson %s and keeps unknown billing through recovery', action => {
    const { store, memory, target, lesson } = usedLesson();
    const harness = new ResearchHarness('memory');
    try {
      harness.request();
      harness.complete();
      const source = harness.state;
      const snapshot = store.loadSnapshot(target.id)!;
      // The helper's synthetic in-flight reply has no matching delivery; use a settled runtime snapshot.
      snapshot.state.domain.reply = null;
      snapshot.state.domain.call = null;
      snapshot.state.domain.items = source.domain.items;
      snapshot.state.domain.jobs = source.domain.jobs;
      snapshot.state.domain.findings = source.domain.findings;
      snapshot.state.domain.researchBudget = source.domain.researchBudget;
      const job = Object.values(source.domain.jobs)[0]!;
      const callId = job.callId!;
      const reservation = source.domain.researchBudget.calls[callId]!.reservedUsd;
      expect(reservation).toBeGreaterThan(0);
      store.commit(target.id, [{
        sessionId: target.id,
        seq: 9,
        eventId: 'research-completion',
        type: 'job.completed',
        acceptedAt: 9,
        payload: {
          jobId: job.id,
          callId,
          investigatorOutput: claims,
          retrievalEvidence: evidence,
        },
      }], snapshot);
      const orphan = structuredClone(snapshot.state);
      orphan.domain.items = {};
      expect(researchContext(orphan).findings).toEqual([]);
      expect(verifiedFindingUrls(orphan.domain)).toEqual([]);
      expect(verifiedFindingUrls(snapshot.state.domain)).toContain(url);
      if (action === 'edit') {
        memory.changeLesson(lesson.id, {
          text: 'Corrected short pilot lesson.',
          terms: ['forecasting'],
          expectedVersion: 1,
          acknowledgeRedaction: true,
        });
      } else {
        memory.removeLesson(lesson.id, 1);
      }
      const redacted = store.loadSnapshot(target.id)!.state;
      expect(redacted.domain.items).toEqual({});
      expect(redacted.domain.jobs).toEqual({});
      expect(redacted.domain.findings).toEqual({});
      expect(redacted.domain.researchBudget.calls[callId]!.reservedUsd).toBe(reservation);
      expect(JSON.stringify(store.readJournal(target.id))).not.toContain(url);
      const runner = new SessionRunner(target.id, loadConfig(), store, () => 20, () => {});
      runner.recover('after-lesson-edit');
      runner.accept({
        eventId: 'reconnect',
        sessionId: target.id,
        type: 'client.connected',
        payload: { modality: 'text' },
      });
      expect(researchContext(runner.current()).findings).toEqual([]);
      expect(outputFailure(`See ${url}`, loadConfig(), verifiedFindingUrls(runner.current().domain))).toBe('url');
      expect(runner.current().domain.researchBudget.calls[callId]!.reservedUsd).toBe(reservation);
      runner.accept({
        eventId: 'late-usage',
        sessionId: target.id,
        type: 'llm.usage',
        payload: {
          callId,
          inputTokens: 1,
          outputTokens: 2,
          queries: 1,
          audioSeconds: 0,
          costUsd: 0.003,
        },
      });
      expect(runner.current().domain.researchBudget.calls[callId]!.reservedUsd).toBe(0);
      expect(runner.current().domain.researchBudget.spentUsd).toBe(0.003);
    } finally {
      harness.store.close();
      store.close();
    }
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
