import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { REDUCER_VERSION, SessionRunner, type RunnerResult } from '../runtime/session-runner.js';
import { MemoryStore, SqliteStore, type SessionStore, type Snapshot } from '../store/index.js';
import { eventSchemaWithEvidenceLimits, type Effect, type KernelEvent } from '../contract/index.js';
import { initialState, reduce, type Decision, type State } from '../kernel/index.js';
import { invariantRegistry } from './invariants.js';
import { readPersistence, verifyPersistence, type Persistence } from './persistence.js';
import { fakePayload, type Fixture } from './schema.js';
import { finalProjection } from './projection.js';
import { FixtureError, type Failure, type Options, type Projection, type TraceEntry } from './types.js';

type Scheduled = {
  at: number;
  order: number;
  event: unknown;
  timer?: string;
};
type Dispatch = Extract<Effect, { type: 'llm.call' | 'job.dispatch' }>;

class SinkCrash extends Error {}

export class World {
  private readonly parser = eventSchemaWithEvidenceLimits(loadConfig());
  private state: State;
  private readonly store?: SessionStore;
  private readonly runner?: SessionRunner;
  private readonly directory?: string;
  private readonly seededSnapshot?: Snapshot;
  private clock = 0;
  private counter = 0;
  private order = 0;
  private fakeIndex = 0;
  private fakeBudget = 0;
  private readonly firedFaults = new Set<number>();
  private crashed = false;
  private external: Scheduled[];
  private timers: Scheduled[] = [];
  private readonly decisions: Decision[] = [];
  private readonly effects: Effect[] = [];
  private readonly failures: Failure[] = [];
  private readonly trace: TraceEntry[] = [];

  constructor(private readonly fixture: Fixture, private readonly options: Options) {
    this.state = initialState(fixture.sessionId, loadConfig());
    if (fixture.initialState) {
      this.state.domain = {
        ...this.state.domain,
        ...fixture.initialState.domain,
      };
    }
    if (options.store) {
      if (options.store === 'sqlite' && !options.storeFactory) {
        this.directory = mkdtempSync(join(tmpdir(), 'sidethought-fixture-'));
      }
      this.store = options.storeFactory?.(options.store)
        ?? (this.directory ? new SqliteStore(join(this.directory, 'fixture.sqlite')) : new MemoryStore());
      if (fixture.initialState) {
        this.seededSnapshot = this.createSeedSnapshot();
        this.store.commit(fixture.sessionId, [], structuredClone(this.seededSnapshot));
      }
      this.runner = new SessionRunner(fixture.sessionId, loadConfig(), this.store, () => this.clock, () => {
        this.maybeCrash();
      });
    } else if (fixture.initialState || fixture.faults?.length || fixture.generate) {
      throw new FixtureError('extended fixtures require a store');
    }
    this.external = this.generateEvents();
    this.external.push(...fixture.events.map(entry => ({
      at: entry.at,
      order: this.order++,
      event: entry.event,
    })));
  }

  private createSeedSnapshot(): Snapshot {
    return {
      seq: this.state.meta.seq,
      reducerVersion: REDUCER_VERSION,
      state: structuredClone(this.state),
    };
  }

  private maybeCrash(): void {
    const seq = this.store?.loadSnapshot(this.fixture.sessionId)?.seq;
    if (seq === undefined || this.firedFaults.has(seq)) return;
    if (this.fixture.faults?.some(fault => fault.afterSeq === seq && fault.kind === 'sinkThrows')) {
      this.firedFaults.add(seq);
      throw new SinkCrash('simulated post-commit crash');
    }
  }

  private generateEvents(): Scheduled[] {
    const count = this.fixture.generate?.repeatCommits ?? 0;
    return Array.from({ length: count }, (_, index) => ({
      at: 0,
      order: this.order++,
      event: {
        eventId: `generated-${index}`,
        sessionId: this.fixture.sessionId,
        type: 'input.committed',
        payload: {
          clientMsgId: 'generated-message',
          text: 'generated input',
          modality: 'text',
        },
      },
    }));
  }

  private scheduleFake(effect: Dispatch, at: number): void {
    const fake = this.fixture.fakes[this.fakeIndex];
    if (!fake) return;
    const role = effect.type === 'llm.call' ? effect.role : 'job';
    if (fake.role !== role && fake.role !== effect.callId) {
      throw new FixtureError(`fake ${this.fakeIndex} does not match ${role}`);
    }
    this.fakeIndex++;
    this.fakeBudget++;
    this.options.fakeHook?.();
    const payload = fakePayload(fake, {
      requestId: effect.type === 'llm.call' ? effect.requestId : '',
      callId: effect.callId,
      jobId: effect.type === 'job.dispatch' ? effect.jobId : '',
    });
    const scheduled = {
      eventId: `fake-${++this.counter}`,
      sessionId: this.fixture.sessionId,
      type: fake.type,
      payload,
    };
    this.parser.parse({
      ...scheduled,
      acceptedAt: at + fake.offset,
    });
    this.external.push({
      at: at + fake.offset,
      order: this.order++,
      event: scheduled,
    });
  }

  private processEffect(effect: Effect, at: number): void {
    if (effect.type === 'timer.set') {
      this.timers.push({
        at: Math.max(at, effect.dueAt),
        order: this.order++,
        timer: effect.timerId,
        event: {
          eventId: `timer-${++this.counter}`,
          sessionId: this.fixture.sessionId,
          type: 'timer.fired',
          payload: {
            timerId: effect.timerId,
            purpose: effect.purpose,
          },
        },
      });
    }
    if (effect.type === 'timer.clear') {
      this.timers = this.timers.filter(timer => timer.timer !== effect.timerId);
    }
    if (effect.type === 'llm.call' || effect.type === 'job.dispatch') this.scheduleFake(effect, at);
  }

  private fire(raw: unknown, at: number): void {
    const event = this.parser.parse({
      ...(raw as object),
      acceptedAt: at,
    });
    const before = this.state;
    let result: RunnerResult;
    try {
      result = this.runEvent(before, event);
    } catch (error) {
      if (!(error instanceof SinkCrash) || !this.runner) throw error;
      this.recordCrash(event, at);
      return;
    }
    this.recordResult(before, event, result, at);
  }

  private runEvent(before: State, event: KernelEvent): RunnerResult {
    if (this.crashed && event.type !== 'session.recovered') {
      throw new FixtureError('recovery must follow a simulated crash');
    }
    if (this.runner && event.type === 'session.recovered') {
      this.checkPersisted();
      this.timers = [];
      const result = this.runner.recover(event.eventId);
      this.crashed = false;
      return result;
    }
    return this.runner ? this.runner.accept(event) : reduce(before, event);
  }

  private recordCrash(event: KernelEvent, at: number): void {
    this.state = this.runner!.current();
    this.timers = [];
    this.crashed = true;
    this.checkPersisted();
    this.decisions.push({
      seq: this.state.meta.seq,
      kind: 'harness',
      reason: 'fault:sinkThrows',
    });
    this.trace.push({
      eventId: event.eventId,
      type: event.type,
      at,
    });
  }

  private recordResult(before: State, event: KernelEvent, result: RunnerResult, at: number): void {
    this.state = result.state;
    this.checkPersisted();
    this.trace.push({
      eventId: event.eventId,
      type: event.type,
      at,
    });
    this.decisions.push(...result.decisions);
    this.effects.push(...result.effects);
    const duplicate = result.decisions[0]?.reason === 'dup:eventId' && result.state.meta.seq === before.meta.seq;
    for (const invariant of duplicate ? [] : invariantRegistry) {
      for (const message of invariant(before, event, this.state, result.effects, result.decisions)) {
        this.failures.push({
          class: 'invariant',
          message,
        });
      }
    }
    for (const effect of result.effects) this.processEffect(effect, at);
  }

  // Equal times: external events in script order first, then timers in set order (M18).
  private advanceTo(end: number): void {
    if (end < this.clock) throw new Error('clock cannot go backwards');
    for (;;) {
      this.external.sort((a, b) => a.at - b.at || a.order - b.order);
      this.timers.sort((a, b) => a.at - b.at || a.order - b.order);
      const external = this.external[0];
      const timer = this.timers[0];
      const queue = external && (!timer || external.at <= timer.at) ? this.external : this.timers;
      const next = queue[0];
      if (!next || next.at > end) break;
      queue.shift();
      this.clock = next.at;
      this.fire(next.event, this.clock);
    }
    this.clock = end;
  }

  private drain(): void {
    while (this.external.length || this.timers.length) {
      const times = [...this.external, ...this.timers].map(entry => entry.at);
      this.advanceTo(Math.min(...times));
    }
  }

  close(): void {
    this.store?.close();
    if (this.directory) {
      rmSync(this.directory, {
        recursive: true,
        force: true,
      });
    }
  }

  private checkPersisted(): void {
    verifyPersistence(this.persistence(), this.failures);
  }

  persistence(): Persistence | undefined {
    return readPersistence(this.store, this.runner, this.fixture.sessionId, this.seededSnapshot);
  }

  run(): { projection: Projection; failures: Failure[]; trace: TraceEntry[] } {
    this.options.replayHook?.();
    this.advanceTo(this.fixture.endAt);
    if (this.fixture.drain) this.drain();
    this.checkPersisted();
    if (this.fakeIndex < this.fixture.fakes.length) throw new FixtureError('unused fake script');
    if (this.firedFaults.size !== (this.fixture.faults?.length ?? 0)) throw new FixtureError('unused fault');
    void this.fakeBudget;
    return {
      failures: this.failures,
      trace: this.trace,
      projection: {
        decisions: this.decisions,
        effects: this.effects,
        final: finalProjection(this.state, this.fixture),
      },
    };
  }
}
