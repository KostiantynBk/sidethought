import { DuplicateEventError, type JournalEvent, type SessionStore, type Snapshot, type Usage } from './types.js';

export class MemoryStore implements SessionStore {
  private snapshots = new Map<string, Snapshot>();
  private events: JournalEvent[] = [];
  private usage: Usage[] = [];

  commit(sessionId: string, events: JournalEvent[], snapshot: Snapshot): void {
    const ids = new Set(this.events.map(event => event.eventId));
    const seqs = new Set(this.events.filter(event => event.sessionId === sessionId).map(event => event.seq));
    for (const event of events) {
      if (ids.has(event.eventId)) throw new DuplicateEventError(event.eventId);
      if (event.sessionId !== sessionId || seqs.has(event.seq)) throw new Error('invalid journal sequence');
      ids.add(event.eventId);
      seqs.add(event.seq);
    }
    const clonedEvents = structuredClone(events);
    const clonedSnapshot = structuredClone(snapshot);
    this.events.push(...clonedEvents);
    this.snapshots.set(sessionId, clonedSnapshot);
  }

  loadSnapshot(sessionId: string): Snapshot | undefined {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot && structuredClone(snapshot);
  }

  readJournal(sessionId: string, fromSeq = 0): JournalEvent[] {
    return structuredClone(this.events.filter(event => event.sessionId === sessionId && event.seq >= fromSeq));
  }

  hasEventId(eventId: string): boolean {
    return this.events.some(event => event.eventId === eventId);
  }

  writeUsage(row: Usage): void {
    this.usage.push({
      callId: row.callId,
      sessionId: row.sessionId,
      role: row.role,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      searches: row.searches,
      audioSeconds: row.audioSeconds,
      estimatedUsd: row.estimatedUsd,
    });
  }

  close(): void {}
}
