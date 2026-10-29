import type { Effect } from '../contract/index.js';
import type { State } from '../kernel/index.js';

export type ModelEffect = Extract<Effect, { type: 'llm.call' | 'llm.abort' }>;
export type RawEvent = { eventId: string; sessionId: string; type: string; payload: unknown };
export interface ModelExecutor {
  handle(effect: ModelEffect, ctx: { state: State; emit: (event: RawEvent) => void }): void;
  shutdown(): Promise<void>;
}
