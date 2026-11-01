import { expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';

function replay(name: string) {
  const path = `fixtures/t06/replay/${name}.json`;
  const memory = replayFixture(path, { store: 'memory' });
  const sqlite = replayFixture(path, { store: 'sqlite' });
  expect(memory.failures).toEqual([]);
  expect(sqlite.failures).toEqual([]);
  expect(memory.ok).toBe(true);
  expect(sqlite.ok).toBe(true);
  expect(memory.snapshot).toBeDefined();
  expect(sqlite.snapshot).toEqual(memory.snapshot);
  expect(memory.unflushedTelemetry).toEqual([]);
  expect(sqlite.unflushedTelemetry).toEqual([]);
  return memory;
}

it('replays S3 inline supersede as an atomic correction in one revision', () => {
  const result = replay('s3-correction-supersede');
  const domain = result.snapshot!.state.domain;
  expect(domain.items.r2?.status).toBe('superseded');
  expect(domain.items.r2?.contentVersion).toBe(1);
  const replacement = Object.values(domain.items).find(item => item.text === 'notes stay on the phone; no cloud');
  expect(replacement?.status).toBe('stated');
  expect(replacement?.contentVersion).toBe(1);
  expect(Object.keys(domain.items)).toHaveLength(2);
  expect(domain.projectRev).toBe(6);
  expect(domain.inputs[0]?.status).toBe('interpreted');
});

it('replays S3e edit race with an atomic conflict and a successful fresh interpretation', () => {
  const result = replay('s3e-typo-edit-race');
  const domain = result.snapshot!.state.domain;
  expect(result.projection!.decisions.map(decision => decision.reason)).toContain('patch:conflict_reinterpret');
  expect(domain.items.r2?.status).toBe('superseded');
  expect(domain.items.r2?.contentVersion).toBe(2);
  expect(Object.values(domain.items).filter(item => item.text === 'notes stay on the phone; no cloud')).toHaveLength(1);
  expect(domain.inputs[0]?.status).toBe('interpreted');
  expect(domain.projectRev).toBe(7);
  const calls = result.projection!.effects.filter(effect => effect.type === 'llm.call');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    capturedInputs: [{
      itemId: 'r2',
      contentVersion: 2,
    }],
  });
});

it('persists no patch changes at the S3e conflict checkpoint', () => {
  const result = replay('s3e-conflict-checkpoint');
  const domain = result.snapshot!.state.domain;
  expect(result.trace?.at(-1)?.type).toBe('interpretation.ready');
  expect(result.projection!.decisions.at(-1)?.reason).toBe('patch:conflict_reinterpret');
  expect(Object.keys(domain.items)).toEqual(['r2']);
  expect(domain.items.r2).toMatchObject({
    status: 'stated',
    text: 'cloud sync via Provider B cloud',
    contentVersion: 2,
  });
  expect(domain.projectRev).toBe(6);
  expect(domain.inputs[0]?.status).toBe('inflight');
  expect(domain.call?.capturedInputs).toEqual([{
    itemId: 'r2',
    contentVersion: 2,
  }]);
});

it('replays 1g with two persisted promised requests and bound dependency versions', () => {
  const result = replay('v1g-two-requests');
  const domain = result.snapshot!.state.domain;
  const created = Object.values(domain.items).find(item => item.text === 'Use local storage')!;
  const jobs = Object.values(domain.jobs);
  expect(domain.pendingRequests).toEqual([]);
  expect(jobs).toHaveLength(2);
  expect(jobs.every(job => job.promised)).toBe(true);
  expect(jobs[0]?.deps).toEqual([{
    itemId: created.id,
    contentVersion: 1,
  }]);
  expect(jobs[1]?.deps).toEqual([
    {
      itemId: 'r1',
      contentVersion: 1,
    },
    {
      itemId: created.id,
      contentVersion: 1,
    },
  ]);
  expect(result.projection!.effects.filter(effect => effect.type === 'llm.call')).toHaveLength(1);
});

it('replays 2f with wait timer set and cleared by the next input', () => {
  const result = replay('v2f-wait');
  const domain = result.snapshot!.state.domain;
  expect(domain.userWait).toBe(false);
  expect(domain.timers.some(timer => timer.purpose === 'userWait')).toBe(false);
  const set = result.projection!.effects.find(effect => effect.type === 'timer.set' && effect.purpose === 'userWait');
  expect(set?.type).toBe('timer.set');
  if (!set || set.type !== 'timer.set') {
    throw new Error('missing userWait timer');
  }
  expect(result.projection!.effects).toContainEqual({
    type: 'timer.clear',
    timerId: set.timerId,
  });
  expect(domain.inputs.map(input => input.kind)).toEqual(['wait', 'statement']);
});

it('replays S5 clarification and persists the combined hedge as considering', () => {
  const result = replay('s5-clarify');
  const domain = result.snapshot!.state.domain;
  expect(Object.values(domain.items).find(item => item.text === 'customer price: €10 per month')?.status)
    .toBe('considering');
  expect(Object.values(domain.items)).toContainEqual(expect.objectContaining({
    kind: 'open_question',
    text: 'operating budget',
  }));
  expect(domain.clarifications).toContainEqual({
    inputIds: ['s.1.1'],
    clarification: 'Your operating budget, or what customers would pay?',
  });
  expect(domain.pendingRequests).toEqual([]);
  expect(domain.inputs.map(input => input.status)).toEqual(['interpreted', 'interpreted']);
});

it('persists the first S5 clarification before any items or research requests exist', () => {
  const result = replay('s5-clarify-checkpoint');
  const domain = result.snapshot!.state.domain;
  expect(domain.items).toEqual({});
  expect(domain.projectRev).toBe(0);
  expect(domain.pendingRequests).toEqual([]);
  expect(domain.clarifications).toEqual([{
    inputIds: ['s.1.1'],
    clarification: 'Your operating budget, or what customers would pay?',
  }]);
  expect(domain.inputs[0]?.status).toBe('interpreted');
});

it('replays a batch containing wait followed by statement without activating userWait', () => {
  const result = replay('mixed-kind-wait-statement');
  const domain = result.snapshot!.state.domain;
  expect(domain.inputs.map(input => input.kind)).toEqual(['statement', 'wait', 'statement']);
  expect(domain.inputs.every(input => input.status === 'interpreted')).toBe(true);
  expect(domain.userWait).toBe(false);
  expect(result.projection!.effects.some(effect => effect.type === 'timer.set' && effect.purpose === 'userWait'))
    .toBe(false);
  expect(domain.replyPending).toBe(true);
});
