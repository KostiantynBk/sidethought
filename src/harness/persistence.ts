import { isDeepStrictEqual } from 'node:util';
import type { SessionRunner } from '../runtime/session-runner.js';
import type { JournalEvent, SessionStore, Snapshot } from '../store/index.js';
import type { Failure } from './types.js';

export type Persistence = {
  actual: Snapshot | undefined;
  expected: Snapshot | undefined;
  unflushed: JournalEvent[];
};

export function readPersistence(
  store: SessionStore | undefined,
  runner: SessionRunner | undefined,
  sessionId: string,
  seededSnapshot: Snapshot | undefined,
): Persistence | undefined {
  if (!store || !runner) return undefined;
  const state = runner.persistenceState();
  return {
    actual: store.loadSnapshot(sessionId),
    expected: state.committed ?? seededSnapshot,
    unflushed: state.unflushed,
  };
}

export function verifyPersistence(persistence: Persistence | undefined, failures: Failure[]): void {
  if (!persistence || isDeepStrictEqual(persistence.actual, persistence.expected)) return;
  const message = 'persisted snapshot differs from committed state';
  if (failures.some(failure => failure.message === message)) return;
  failures.push({
    class: 'invariant',
    message,
  });
}
