import { isDeepStrictEqual } from 'node:util';
import type { Effect, KernelEvent } from '../contract/index.js';
import { assembleContext } from '../context/index.js';
import type { State } from '../kernel/index.js';
import type { Fixture } from './schema.js';
import type { Failure, TraceEntry } from './types.js';

export function contextCheckpoint(fixture: Fixture, event: KernelEvent, state: State, effects: Effect[]): Failure[] {
  const failures: Failure[] = [];
  for (const checkpoint of fixture.contextCheckpoints ?? []) {
    if (checkpoint.afterEventId !== event.eventId) continue;
    const effect = effects.find(item => item.type === 'llm.call' && item.role === checkpoint.role);
    if (!effect || effect.type !== 'llm.call') {
      failures.push({
        class: 'invariant',
        message: `context checkpoint missing call: ${checkpoint.afterEventId}`,
      });
      continue;
    }
    if (!isDeepStrictEqual(assembleContext(state, effect), checkpoint.expected)) {
      failures.push({
        class: 'invariant',
        message: `context checkpoint differs: ${checkpoint.afterEventId}`,
      });
    }
  }
  return failures;
}

export function unusedContextCheckpoints(fixture: Fixture, trace: TraceEntry[]): Failure[] {
  return (fixture.contextCheckpoints ?? []).filter(checkpoint =>
    !trace.some(entry => entry.eventId === checkpoint.afterEventId)).map(checkpoint => ({
    class: 'invariant',
    message: `context checkpoint not reached: ${checkpoint.afterEventId}`,
  }));
}
