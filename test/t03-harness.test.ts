import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { replayFixture } from '../src/harness/index.js';
import { basicFixture, basicPath, basicSource, readyOutput, withTemporary } from './t03-helpers.js';

const required = [
  'commit-basic.json',
  'dup-eventid-clientmsgid.json',
  'interpreter-single-flight.json',
  'retry-late-attempt.json',
];
const actual = readdirSync('fixtures').filter(name => name.endsWith('.json')).sort();

describe('reviewed fixtures', () => {
  it('has the exact required fixture set', () => {
    expect(actual).toEqual(required);
  });

  it.each(required)('replays %s', file => {
    const result = replayFixture(join('fixtures', file));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('replay self-tests', () => {
  it('reports a mutated expected decision as drift', () => {
    const fixture = basicFixture();
    fixture.expected.decisions[0].reason = 'mutated';
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path);
      expect(result.ok).toBe(false);
      expect(result.failures.some(failure => failure.class === 'decision_drift')).toBe(true);
    });
  });

  it('rejects malformed JSON and unknown schema versions', () => {
    const wrongVersion = basicSource.replace('"schemaVersion": 1', '"schemaVersion": 99');
    for (const body of ['{', wrongVersion]) {
      withTemporary(body, path => {
        const result = replayFixture(path);
        expect(result.ok).toBe(false);
        expect(result.failures[0]?.class).toBe('fixture_schema');
      });
    }
  });

  it('rejects a fake with offset zero', () => {
    const fixture = basicFixture();
    fixture.fakes = [{
      role: 'interpreter',
      offset: 0,
      type: 'interpretation.failed',
      reason: 'x',
    }];
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path);
      expect(result.ok).toBe(false);
      expect(result.failures[0]?.class).toBe('fixture_schema');
    });
  });

  it('classifies a throwing fake as harness, not an event', () => {
    const fixture = basicFixture();
    fixture.fakes = [{
      role: 'interpreter',
      offset: 1,
      type: 'interpretation.failed',
      reason: 'x',
    }];
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path, { fakeHook: () => { throw new Error('fake exception'); } });
      expect(result.ok).toBe(false);
      expect(result.failures[0]?.class).toBe('harness');
      expect(result.projection).toBeUndefined();
      expect(result.trace).toBeUndefined();
    });
  });

  it('classifies a caught fetch attempt as harness', () => {
    const result = replayFixture(basicPath, {
      replayHook: () => {
        try {
          void fetch('https://example.com');
        } catch {
          // The latch must still reject the run.
        }
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.class).toBe('harness');
  });

  it('replays the same fixture to byte-identical projections', () => {
    const first = replayFixture(basicPath);
    const second = replayFixture(basicPath);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(JSON.stringify(first.projection)).toBe(JSON.stringify(second.projection));
  });

  it('isolates serialized fixture worlds with different horizons, clocks and counters', async () => {
    const short = timedFixture(5, 3);
    const long = timedFixture(900, 4);
    await withTemporaryAsync(JSON.stringify(short), JSON.stringify(long));
  });
});

function timedFixture(endAt: number, offset: number) {
  const fixture = basicFixture();
  fixture.endAt = endAt;
  fixture.fakes = [{
    role: 'interpreter',
    offset,
    type: 'interpretation.ready',
    output: readyOutput,
  }];
  fixture.expected.decisions.push({
    seq: 2,
    kind: 'kernel',
    reason: 'interpreter:ready',
  });
  fixture.expected.final.seq = 2;
  fixture.expected.final.inFlight = null;
  fixture.expected.final.uninterpreted = [];
  if (endAt >= 800) {
    fixture.expected.decisions.push({
      seq: 3,
      kind: 'kernel',
      reason: 'reply:started',
    });
    fixture.expected.effects.push({
      type: 'llm.call',
      role: 'responder',
      requestId: 's.3.1',
      callId: 's.3.2',
      basisRev: 0,
      capturedInputs: [],
    });
    fixture.expected.effects.push({
      type: 'timer.set',
      timerId: 's.3.4',
      purpose: 'firstTokenTimeout',
      dueAt: 8800,
    }, {
      type: 'timer.set',
      timerId: 's.3.5',
      purpose: 'callDeadline',
      dueAt: 20800,
    });
    fixture.expected.final.seq = 3;
    fixture.expected.final.pendingTimers = [{
      timerId: 's.3.4',
      purpose: 'firstTokenTimeout',
      dueAt: 8800,
    }, {
      timerId: 's.3.5',
      purpose: 'callDeadline',
      dueAt: 20800,
    }];
  }
  return fixture;
}

async function withTemporaryAsync(short: string, long: string): Promise<void> {
  // Nesting cleanup around a returned promise would remove the files too early.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'st-t03-worlds-'));
  const a = join(dir, 'short.json');
  const b = join(dir, 'long.json');
  try {
    writeFileSync(a, short);
    writeFileSync(b, long);
    const standaloneA = replayFixture(a);
    const standaloneB = replayFixture(b);
    const [parallelA, parallelB] = await Promise.all([
      Promise.resolve().then(() => replayFixture(a)),
      Promise.resolve().then(() => replayFixture(b)),
    ]);
    expect(standaloneA.ok).toBe(true);
    expect(standaloneB.ok).toBe(true);
    expect(parallelA).toEqual(standaloneA);
    expect(parallelB).toEqual(standaloneB);
    expect(parallelA.trace).toContainEqual({
      eventId: 'fake-2',
      type: 'interpretation.ready',
      at: 3,
    });
    expect(parallelB.trace).toContainEqual({
      eventId: 'fake-2',
      type: 'interpretation.ready',
      at: 4,
    });
    expect(parallelA.projection?.final).toMatchObject({ pendingTimers: [{ dueAt: 800 }] });
    expect(parallelB.projection?.final).toMatchObject({
      pendingTimers: [{
        timerId: 's.3.4',
        purpose: 'firstTokenTimeout',
        dueAt: 8800,
      }, {
        timerId: 's.3.5',
        purpose: 'callDeadline',
        dueAt: 20800,
      }],
    });
    expect(parallelB.trace).toContainEqual({
      eventId: 'timer-1',
      type: 'timer.fired',
      at: 800,
    });
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  }
}
