import type { Effect } from '../contract/index.js';
import type { Decision } from '../kernel/index.js';
import type { SessionStore } from '../store/index.js';

export type Failure = {
  class: 'invariant' | 'decision_drift' | 'effect_drift' | 'fixture_schema' | 'harness';
  message: string;
};
export type Projection = {
  decisions: Decision[];
  effects: Effect[];
  final: unknown;
};
export type TraceEntry = {
  eventId: string;
  type: string;
  at: number;
};
export type Options = {
  store?: 'memory' | 'sqlite';
  storeFactory?: (kind: 'memory' | 'sqlite') => SessionStore;
  fakeHook?: () => void;
  replayHook?: () => void;
};
export class FixtureError extends Error {}
