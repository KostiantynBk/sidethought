import type Database from 'better-sqlite3';
import type { State } from '../kernel/index.js';
import { purgeOrphanResearch } from '../kernel/research/purge-orphans.js';
import type { LessonUse } from './types.js';

const marker = '[Reply removed after a shared lesson changed.]';

function sequence(id: string): number {
  const match = /\.(\d+)\.\d+$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function redactState(state: State, since: number): string[] {
  // T13: later replies may have indirectly reused the lesson through recent conversation.
  // Preserve user messages, but conservatively clear extracted state and downstream replies.
  state.domain.items = {};
  const removedJobs = purgeOrphanResearch(state);
  state.domain.projectRev += 1;
  state.domain.pendingRequests = [];
  state.domain.clarifications = [];
  state.domain.interruptedCalls = [];
  if (state.domain.call) state.domain.call.quoteWitness = { recent: [], sources: [] };
  if (state.domain.reply) state.domain.reply.buffer = '';
  state.domain.inputs = state.domain.inputs.filter(input => (input.origin ?? 'user') === 'user');
  for (const delivery of Object.values(state.domain.deliveries)) {
    if (sequence(delivery.callId) < since) continue;
    delivery.chunks = [{ text: marker, state: 'rendered', claimIds: [], sentenceFinished: true }];
    delivery.interruptedPrefix = marker;
    delivery.deliveredChars = marker.length;
    delivery.sentChars = marker.length;
    delivery.claimsDelivered = [];
    delivery.state = 'interrupted';
    delivery.aborted = true;
    delivery.settled = true;
    delivery.doneSent = true;
    delivery.finalAcknowledged = true;
  }
  return removedJobs;
}

function redactResearchJournal(db: Database.Database, sessionId: string, removedJobs: string[]): void {
  const removed = new Set(removedJobs);
  const rows = db.prepare("SELECT seq, payload FROM journal WHERE sessionId = ? AND type = 'job.completed'")
    .all(sessionId) as Array<{ seq: number; payload: string }>;
  const update = db.prepare('UPDATE journal SET payload = ? WHERE sessionId = ? AND seq = ?');
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    if (!removed.has(payload.jobId)) continue;
    payload.investigatorOutput = { verdict: 'inconclusive', claims: [], caveats: [] };
    payload.retrievalEvidence = { completedSearchCalls: 0, issuedQueries: [], results: [] };
    update.run(JSON.stringify(payload), sessionId, row.seq);
  }
}

function redactJournal(db: Database.Database, sessionId: string, since: number): void {
  const rows = db.prepare(`SELECT seq, type, payload FROM journal
    WHERE sessionId = ? AND seq >= ? AND type IN ('reply.chunk', 'interpretation.ready')`)
    .all(sessionId, since) as Array<{ seq: number; type: string; payload: string }>;
  const update = db.prepare('UPDATE journal SET payload = ? WHERE sessionId = ? AND seq = ?');
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    if (row.type === 'reply.chunk') payload.text = marker;
    else payload.output = {
      inputKinds: [],
      ops: [],
      replacementGroups: [],
      researchRequests: [],
      deprioritizedTopics: [],
      voiceConfirmValues: [],
    };
    update.run(JSON.stringify(payload), sessionId, row.seq);
  }
}

// Called inside the lesson mutation transaction. No content-only copy is kept in the audit table.
export function redactLessonUses(db: Database.Database, uses: LessonUse[]): string[] {
  const earliest = new Map<string, number>();
  for (const use of uses) {
    earliest.set(use.sessionId, Math.min(earliest.get(use.sessionId) ?? Infinity, sequence(use.callId)));
  }
  for (const [sessionId, since] of earliest) {
    const snapshot = db.prepare('SELECT stateJson FROM snapshots WHERE sessionId = ?')
      .get(sessionId) as { stateJson: string } | undefined;
    if (snapshot) {
      const state = JSON.parse(snapshot.stateJson) as State;
      const removedJobs = redactState(state, since);
      redactResearchJournal(db, sessionId, removedJobs);
      db.prepare('UPDATE snapshots SET stateJson = ? WHERE sessionId = ?').run(JSON.stringify(state), sessionId);
    }
    redactJournal(db, sessionId, since);
  }
  return [...earliest.keys()];
}
