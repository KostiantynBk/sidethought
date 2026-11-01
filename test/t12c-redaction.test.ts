import { expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';
import { memorySetup, saveState } from './t13-memory-helpers.js';

function waitingCandidate() {
  const setup = memorySetup();
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  const item = h.statement('Plan a forecasting pilot on this laptop.');
  h.passReply();
  h.timer('deliberationDebounce');
  const call = h.state.domain.initiative.deliberation!;
  const supplied = {
    lessonId: setup.lesson.id,
    version: setup.lesson.version,
    sourceProjectName: setup.lesson.sourceProjectName,
    text: setup.lesson.text,
  };
  h.send('deliberation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    suppliedLessons: [supplied],
    output: { nominations: [{
      kind: 'insight',
      topic: 'Past pilot',
      insight: setup.lesson.text,
      lessonIds: [setup.lesson.id],
      depItemIds: [item],
      scores,
    }] },
  });
  const state = structuredClone(h.state);
  state.sessionId = setup.target.id;
  saveState(setup.store, state);
  setup.memory.recordUse(`${setup.target.id}.1.1`, setup.target.id, [setup.lesson]);
  h.store.close();
  return setup;
}

function expectPurged(setup: ReturnType<typeof waitingCandidate>): void {
  const state = setup.store.loadSnapshot(setup.target.id)!.state;
  const candidate = Object.values(state.domain.initiative.candidates)[0]!;
  expect(candidate.state).toBe('dropped');
  expect(JSON.stringify(state)).not.toContain(setup.lesson.text);
  expect(setup.memory.recentUses(setup.target.id)).toEqual([expect.objectContaining({
    lessonId: setup.lesson.id,
    version: 1,
  })]);
}

it('drops a waiting candidate when its lesson is edited and retains the audit', () => {
  const setup = waitingCandidate();
  setup.memory.changeLesson(setup.lesson.id, {
    text: 'A corrected pilot lesson.',
    terms: ['forecasting'],
    expectedVersion: 1,
    acknowledgeRedaction: true,
  });
  expectPurged(setup);
});

it('drops a waiting candidate when its lesson is forgotten and retains the audit', () => {
  const setup = waitingCandidate();
  setup.memory.removeLesson(setup.lesson.id, 1);
  expectPurged(setup);
});
