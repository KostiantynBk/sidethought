import type { KernelEvent } from '../contract/index.js';
import type { State } from '../kernel/index.js';

export type JournalEvent = KernelEvent & {
  seq: number;
  acceptedAt: number;
};
export type Snapshot = {
  seq: number;
  reducerVersion: string;
  state: State;
};
export type Usage = {
  callId: string;
  sessionId: string;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  audioSeconds: number;
  estimatedUsd: number;
};
export interface SessionStore {
  commit(sessionId: string, events: JournalEvent[], snapshot: Snapshot): void;
  loadSnapshot(sessionId: string): Snapshot | undefined;
  upgradeSnapshot?(sessionId: string, snapshot: Snapshot): void;
  hasChangedLessonUse?(sessionId: string): boolean;
  readJournal(sessionId: string, fromSeq?: number): JournalEvent[];
  hasEventId(eventId: string): boolean;
  writeUsage(row: Usage): void;
  close(): void;
}
export class DuplicateEventError extends Error {
  constructor(readonly eventId: string) {
    super(`duplicate eventId: ${eventId}`);
  }
}
