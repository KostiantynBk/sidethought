import type { Config } from '../config/index.js';
import { eventSchemaWithEvidenceLimits, TELEMETRY_EVENT_TYPES, type Effect } from '../contract/index.js';
import { initialState, reduce, type Decision, type State } from '../kernel/index.js';
import { DuplicateEventError, type JournalEvent, type SessionStore, type Snapshot } from '../store/index.js';

export const REDUCER_VERSION = '4';

export class ReducerVersionMismatchError extends Error {
  constructor(readonly found: string) {
    super(`reducerVersion mismatch: expected ${REDUCER_VERSION}, found ${found}`);
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
  private pendingEffects: Effect[] = [];
  private committed?: Snapshot;
  private readonly parser;

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

  accept(raw: unknown): RunnerResult {
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
    if ((TELEMETRY_EVENT_TYPES as readonly string[]).includes(event.type)) {
      this.pending.push(event);
      this.pendingEffects.push(...result.effects);
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
    const effects = [...this.pendingEffects, ...result.effects];
    this.pending = [];
    this.pendingEffects = [];
    this.state = result.state;
    this.committed = snapshot;
    if (effects.length) this.sink(effects);
    return result;
  }

  recover(eventId: string): RunnerResult {
    const snapshot = this.store.loadSnapshot(this.sessionId);
    if (!snapshot) throw new Error(`no snapshot for ${this.sessionId}`);
    if (snapshot.reducerVersion !== REDUCER_VERSION) throw new ReducerVersionMismatchError(snapshot.reducerVersion);
    this.state = snapshot.state;
    this.committed = structuredClone(snapshot);
    this.pending = [];
    this.pendingEffects = [];
    return this.accept({
      eventId,
      sessionId: this.sessionId,
      type: 'session.recovered',
      payload: {},
    });
  }
}
