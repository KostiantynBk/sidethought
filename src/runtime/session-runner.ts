import type { Config } from '../config/index.js';
import { eventSchemaWithEvidenceLimits, TELEMETRY_EVENT_TYPES, type Effect } from '../contract/index.js';
import { initialState, reduce, type Decision, type State } from '../kernel/index.js';
import { DuplicateEventError, type JournalEvent, type SessionStore, type Snapshot } from '../store/index.js';
import { invariantRegistry } from '../harness/invariants.js';

export const REDUCER_VERSION = '12';

export class ReducerVersionMismatchError extends Error {
  constructor(readonly found: string) {
    super(`reducerVersion mismatch: expected ${REDUCER_VERSION}, found ${found}`);
  }
}

export class ProjectUpgradeError extends ReducerVersionMismatchError {
  constructor(readonly reason: 'lesson_changed' | 'replay_failed') {
    super('unavailable');
    this.message = reason === 'lesson_changed'
      ? "Saved by an older version; a lesson it used was later changed, so it can't be upgraded automatically."
      : "Saved by an older version; this project can't be upgraded automatically.";
  }
}

export type RunnerResult = {
  state: State;
  effects: Effect[];
  decisions: Decision[];
};

export class SessionRunner {
  private state: State;
  private pending: JournalEvent[] = [];
  private committed?: Snapshot;
  private readonly parser;
  private suspended = false;
  private recovering = false;

  constructor(
    private readonly sessionId: string,
    private readonly config: Config,
    private readonly store: SessionStore,
    private readonly clock: () => number,
    private readonly sink: (effects: Effect[]) => void,
  ) {
    this.state = initialState(sessionId, config);
    this.parser = eventSchemaWithEvidenceLimits(config);
  }

  current(): State {
    return structuredClone(this.state);
  }

  persistenceState(): { committed: Snapshot | undefined; unflushed: JournalEvent[] } {
    return {
      committed: this.committed && structuredClone(this.committed),
      unflushed: structuredClone(this.pending),
    };
  }

  private duplicate(): RunnerResult {
    return {
      state: this.current(),
      effects: [],
      decisions: [{
        seq: this.state.meta.seq,
        kind: 'kernel',
        reason: 'dup:eventId',
      }],
    };
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  suspendForMemoryChange(): void {
    // Fence persistence before any abort/recovery can fail. Never expose the old RAM snapshot again.
    this.suspended = true;
    this.pending = [];
    this.state = initialState(this.sessionId, this.config);
    const snapshot = this.store.loadSnapshot(this.sessionId);
    if (snapshot) this.state = structuredClone(snapshot.state);
    this.committed = snapshot;
  }

  accept(raw: unknown): RunnerResult {
    if (this.suspended && !this.recovering) throw new Error('session paused after memory change');
    const parsed = this.parser.parse({
      ...(raw as object),
      acceptedAt: this.clock(),
    });
    if (parsed.sessionId !== this.sessionId) throw new Error('invalid session');
    if (this.store.hasEventId(parsed.eventId) || this.pending.some(event => event.eventId === parsed.eventId)) {
      return this.duplicate();
    }
    const event: JournalEvent = {
      ...parsed,
      acceptedAt: parsed.acceptedAt!,
      seq: this.state.meta.seq + 1,
    };
    return this.apply(event);
  }

  private apply(event: JournalEvent): RunnerResult {
    const result = reduce(this.state, event);
    // §6.3 / T07 decision 9: external effects require a durable snapshot, even on a delta/activity event.
    if ((TELEMETRY_EVENT_TYPES as readonly string[]).includes(event.type) && result.effects.length === 0) {
      this.pending.push(event);
      this.state = result.state;
      return {
        ...result,
        effects: [],
      };
    }
    const snapshot: Snapshot = {
      seq: result.state.meta.seq,
      reducerVersion: REDUCER_VERSION,
      state: structuredClone(result.state),
    };
    try {
      this.store.commit(this.sessionId, [...this.pending, event], structuredClone(snapshot));
    } catch (error) {
      if (error instanceof DuplicateEventError && error.eventId === event.eventId) return this.duplicate();
      throw error;
    }
    const effects = result.effects;
    this.pending = [];
    this.state = result.state;
    this.committed = snapshot;
    if (effects.length) this.sink(effects);
    return result;
  }

  private upgrade(snapshot: Snapshot): Snapshot {
    if (!this.store.upgradeSnapshot || !this.store.hasChangedLessonUse) {
      throw new ReducerVersionMismatchError(snapshot.reducerVersion);
    }
    if (this.store.hasChangedLessonUse(this.sessionId)) throw new ProjectUpgradeError('lesson_changed');
    let state = initialState(this.sessionId, this.config);
    try {
      const journal = this.store.readJournal(this.sessionId);
      if (!journal.length || journal.at(-1)!.seq !== snapshot.seq) throw new Error('Incomplete journal');
      for (const row of journal) {
        const { seq, ...raw } = row;
        const event = this.parser.parse(raw);
        if (event.sessionId !== this.sessionId || seq !== state.meta.seq + 1) throw new Error('Invalid sequence');
        const result = reduce(state, { ...event, seq });
        const failed = invariantRegistry.some(check =>
          check(state, event, result.state, result.effects, result.decisions).length);
        if (failed) {
          throw new Error('Invariant failure');
        }
        state = result.state;
      }
    } catch {
      throw new ProjectUpgradeError('replay_failed');
    }
    const upgraded = { seq: state.meta.seq, reducerVersion: REDUCER_VERSION, state };
    try {
      this.store.upgradeSnapshot(this.sessionId, upgraded);
    } catch {
      throw new ProjectUpgradeError('replay_failed');
    }
    return upgraded;
  }

  recover(eventId: string): RunnerResult {
    let snapshot = this.store.loadSnapshot(this.sessionId);
    if (!snapshot) throw new Error(`no snapshot for ${this.sessionId}`);
    if (snapshot.reducerVersion !== REDUCER_VERSION) snapshot = this.upgrade(snapshot);
    this.state = snapshot.state;
    this.committed = structuredClone(snapshot);
    this.pending = [];
    this.recovering = true;
    try {
      const result = this.accept({
        eventId,
        sessionId: this.sessionId,
        type: 'session.recovered',
        payload: {},
      });
      this.suspended = false;
      return result;
    } finally {
      this.recovering = false;
    }
  }
}
