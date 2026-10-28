import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { replayFixture } from '../src/harness/index.js';
import { basicFixture, readyOutput, withTemporary } from './t03-helpers.js';

describe('fake consumption', () => {
  it.each([false, true])('rejects a never-dispatched fake with drain=%s', drain => {
    const fixture = JSON.parse(readFileSync('fixtures/retry-late-attempt.json', 'utf8'));
    fixture.drain = drain;
    fixture.fakes.push({
      role: 'never-dispatched',
      offset: 1,
      type: 'interpretation.failed',
      reason: 'unused',
    });
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path);
      expect(result.ok).toBe(false);
      expect(result.failures[0]?.class).toBe('fixture_schema');
    });
  });

  it('reports a caught network attempt and a never-dispatched fake together', () => {
    const fixture = JSON.parse(readFileSync('fixtures/retry-late-attempt.json', 'utf8'));
    fixture.fakes.push({
      role: 'never-dispatched',
      offset: 1,
      type: 'interpretation.failed',
      reason: 'unused',
    });
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path, {
        replayHook: () => {
          try {
            void fetch('https://example.com');
          } catch {
            // The later fixture error must not mask the latched attempt.
          }
        },
      });
      expect(result.ok).toBe(false);
      expect(result.failures.map(failure => failure.class)).toEqual(['harness', 'fixture_schema']);
    });
  });

  it('allows a matched response scheduled beyond the cutoff', () => {
    const fixture = basicFixture();
    fixture.fakes = [{
      role: 'interpreter',
      offset: 100,
      type: 'interpretation.ready',
      output: readyOutput,
    }];
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path);
      expect(result.ok).toBe(true);
      expect(result.trace).toHaveLength(1);
      expect(result.projection?.final).toMatchObject({
        inFlight: { callId: 's.1.4' },
        uninterpreted: [{ status: 'inflight' }],
      });
    });
  });

  it('rejects malformed role output during load', () => {
    const fixture = basicFixture();
    fixture.fakes = [{
      role: 'interpreter',
      offset: 1,
      type: 'interpretation.ready',
      output: {
        inputKinds: [{
          inputId: 's.1.1',
          kind: 'statement',
        }],
        seenContentVersion: 10,
      },
    }];
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path);
      expect(result.ok).toBe(false);
      expect(result.failures[0]?.class).toBe('fixture_schema');
    });
  });
});
