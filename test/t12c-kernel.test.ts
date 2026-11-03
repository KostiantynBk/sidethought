import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { EventSchema } from '../src/contract/index.js';
import { initialState, reduce } from '../src/kernel/index.js';
import { ContributionHarness, scores } from './t12a-helpers.js';

const lesson = {
  lessonId: 'lesson-a',
  version: 1,
  sourceProjectName: 'Memory A',
  text: 'The pilot took 43 minutes on this laptop.',
};

function setup(kind: 'memory' | 'sqlite' = 'memory') {
  const h = new ContributionHarness(kind, {}, []);
  h.connect();
  const item = h.statement('Plan a forecasting pilot on this laptop.');
  h.passReply();
  h.timer('deliberationDebounce');
  return { h, item, call: h.state.domain.initiative.deliberation! };
}

function insight(h: ContributionHarness, item: string, supplied = [lesson], cited = [lesson.lessonId]) {
  const call = h.state.domain.initiative.deliberation!;
  h.send('deliberation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    suppliedLessons: supplied,
    output: { nominations: [{
      kind: 'insight',
      topic: 'Pilot experience',
      insight: lesson.text,
      depItemIds: [item],
      lessonIds: cited,
      scores,
    }] },
  });
}

it('delivers an attributed lesson insight without another user message', () => {
  const { h, item } = setup();
  insight(h, item);
  h.timer('floorGap');
  h.check('In Memory A you found: The pilot took 43 minutes on this laptop.');
  h.acknowledge();
  const candidate = Object.values(h.state.domain.initiative.candidates)[0]!;
  expect(candidate.state).toBe('delivered');
  expect(candidate.source.lessons).toEqual([lesson]);
  expect(h.state.domain.inputs.filter(input => (input.origin ?? 'user') === 'user')).toHaveLength(1);
  h.store.close();
});

it('rejects a citation when no lessons were supplied', () => {
  const { h, item } = setup();
  insight(h, item, []);
  expect(Object.values(h.state.domain.initiative.candidates)).toHaveLength(0);
  expect(h.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'inspector.decision'
    && effect.message.reason.includes('unknown_lesson'))).toBe(true);
  h.store.close();
});

it('rejects an extra unknown lesson citation', () => {
  const { h, item } = setup();
  insight(h, item, [lesson], [lesson.lessonId, 'unknown']);
  expect(Object.values(h.state.domain.initiative.candidates)).toHaveLength(0);
  h.store.close();
});

it('requires approval for a lesson-citing investigation', () => {
  const { h, item, call } = setup();
  h.send('deliberation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    suppliedLessons: [lesson],
    output: { nominations: [{
      kind: 'investigation',
      topic: 'Pilot',
      question: 'How long should the pilot take?',
      publicQuery: 'forecast pilot runtime',
      depItemIds: [item],
      lessonIds: [lesson.lessonId],
      scores,
    }] },
  });
  expect(Object.values(h.state.domain.jobs)[0]?.state).toBe('awaiting_user');
  expect(h.effects.some(effect => effect.type === 'job.dispatch')).toBe(false);
  h.store.close();
});

it('requires approval when the investigation query repeats a lesson term', () => {
  const { h, item, call } = setup();
  h.send('deliberation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    suppliedLessons: [lesson],
    output: { nominations: [{
      kind: 'investigation',
      topic: 'Runtime',
      question: 'How long can a laptop run?',
      publicQuery: 'laptop runtime',
      depItemIds: [item],
      lessonIds: [],
      scores,
    }] },
  });
  expect(Object.values(h.state.domain.jobs)[0]?.state).toBe('awaiting_user');
  h.store.close();
});

it('replays identical lesson events in memory and SQLite', () => {
  const memory = setup('memory');
  const sqlite = setup('sqlite');
  insight(memory.h, memory.item);
  insight(sqlite.h, sqlite.item);
  expect(sqlite.h.state).toEqual(memory.h.state);
  expect(sqlite.h.store.readJournal('s')).toEqual(memory.h.store.readJournal('s'));
  expect(JSON.stringify(sqlite.h.store.readJournal('s'))).toContain('Memory A');
  const replayed = sqlite.h.store.readJournal('s').reduce((state, record) => {
    const { seq: _seq, ...event } = record;
    return reduce(state, EventSchema.parse(event)).state;
  }, initialState('s', loadConfig()));
  expect(replayed).toEqual(sqlite.h.state);
  memory.h.store.close();
  sqlite.h.store.close();
});

it('demotes a Checker utterance containing an unsupported number', () => {
  const { h, item } = setup();
  insight(h, item);
  h.timer('floorGap');
  h.check('In Memory A you found: The pilot took 99 minutes on this laptop.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('card_only');
  h.store.close();
});

it('demotes a Checker utterance without source attribution', () => {
  const { h, item } = setup();
  insight(h, item);
  h.timer('floorGap');
  h.check('The pilot took 43 minutes on this laptop.');
  expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('card_only');
  h.store.close();
});
