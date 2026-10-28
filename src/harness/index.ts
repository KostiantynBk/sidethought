import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from '../config/index.js';
import { eventSchemaWithEvidenceLimits } from '../contract/index.js';
import { guarded, NetworkAttemptError } from './guard.js';
import { fakePayload, fixtureSchema, type Fixture } from './schema.js';
import { FixtureError, type Failure, type Options, type Projection, type TraceEntry } from './types.js';
import { World } from './world.js';
import type { JournalEvent, Snapshot } from '../store/index.js';

export { invariantRegistry } from './invariants.js';
export type { Failure } from './types.js';

type ReplayResult = {
  ok: boolean;
  failures: Failure[];
  projection?: Projection;
  trace?: TraceEntry[];
  snapshot?: Snapshot;
  unflushedTelemetry?: JournalEvent[];
};

function loadFixture(path: string): Fixture {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const fixture = fixtureSchema.parse(raw);
  const parser = eventSchemaWithEvidenceLimits(loadConfig());
  for (const { at, event } of fixture.events) {
    parser.parse({
      ...(event as object),
      acceptedAt: at,
    });
  }
  for (const fake of fixture.fakes) {
    const payload = fakePayload(fake, {
      requestId: 'validation',
      callId: 'validation',
      jobId: 'validation',
    });
    parser.parse({
      eventId: 'validation',
      sessionId: fixture.sessionId,
      acceptedAt: 0,
      type: fake.type,
      payload,
    });
  }
  if (fixture.events.some(event => event.at > fixture.endAt) && !fixture.drain) {
    throw new FixtureError('events after endAt cause partial load');
  }
  return fixture;
}

function compare(fixture: Fixture, projection: Projection, failures: Failure[]): void {
  const summary = fixture.assertions;
  const final = projection.final as { seq: number };
  const decisionDrift = summary
    ? projection.decisions.length !== summary.decisionCount
      || projection.decisions.at(-1)?.reason !== summary.lastDecision
      || final.seq !== summary.finalSeq
    : !isDeepStrictEqual(projection.decisions, fixture.expected.decisions);
  const finalDrift = !isDeepStrictEqual(projection.final, fixture.expected.final);
  if (decisionDrift || finalDrift) {
    failures.push({
      class: 'decision_drift',
      message: 'decisions or final state differ',
    });
  }
  if (!isDeepStrictEqual(projection.effects, fixture.expected.effects)) {
    failures.push({
      class: 'effect_drift',
      message: 'effects differ',
    });
  }
}

export function replayFixture(path: string, options: Options = {}): ReplayResult {
  let fixture: Fixture;
  try {
    fixture = loadFixture(path);
  } catch (error) {
    return {
      ok: false,
      failures: [{
        class: 'fixture_schema',
        message: String(error),
      }],
    };
  }
  try {
    const world = new World(fixture, options);
    try {
      const { projection, failures, trace } = guarded(() => world.run());
      compare(fixture, projection, failures);
      const persistence = world.persistence();
      return {
        ok: failures.length === 0,
        failures,
        projection,
        trace,
        snapshot: persistence?.actual,
        unflushedTelemetry: persistence?.unflushed,
      };
    } finally {
      world.close();
    }
  } catch (error) {
    if (error instanceof NetworkAttemptError) {
      const failures: Failure[] = [{
        class: 'harness',
        message: error.message,
      }];
      if (error.replayError instanceof FixtureError) {
        failures.push({
          class: 'fixture_schema',
          message: String(error.replayError),
        });
      } else if (error.replayError !== undefined) {
        failures.push({
          class: 'harness',
          message: String(error.replayError),
        });
      }
      return {
        ok: false,
        failures,
      };
    }
    const failureClass = error instanceof FixtureError ? 'fixture_schema' : 'harness';
    return {
      ok: false,
      failures: [{
        class: failureClass,
        message: String(error),
      }],
    };
  }
}
