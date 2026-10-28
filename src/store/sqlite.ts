import Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';
import { DuplicateEventError, type JournalEvent, type SessionStore, type Snapshot, type Usage } from './types.js';

type SnapshotRow = {
  seq: number;
  reducerVersion: string;
  stateJson: string;
};

type Pragmas = {
  journalMode: string;
  secureDelete: number;
  foreignKeys: number;
};

export class SqliteStore implements SessionStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('secure_delete = ON');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  commit(sessionId: string, events: JournalEvent[], snapshot: Snapshot): void {
    try {
      this.db.transaction(() => {
        this.db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run(sessionId);
        const insert = this.db.prepare(`INSERT INTO journal
          (sessionId, seq, eventId, type, causalParent, acceptedAt, observedAt, payload)
          VALUES (@sessionId, @seq, @eventId, @type, @causalParent, @acceptedAt, @observedAt, @payload)`);
        for (const event of events) {
          if (event.sessionId !== sessionId) throw new Error('invalid journal session');
          insert.run({
            ...event,
            causalParent: event.causalParent ?? null,
            observedAt: event.observedAt ?? null,
            payload: JSON.stringify(event.payload),
          });
        }
        this.db.prepare(`INSERT INTO snapshots (sessionId, seq, reducerVersion, stateJson)
          VALUES (?, ?, ?, ?) ON CONFLICT(sessionId) DO UPDATE SET
          seq=excluded.seq, reducerVersion=excluded.reducerVersion, stateJson=excluded.stateJson`)
          .run(sessionId, snapshot.seq, snapshot.reducerVersion, JSON.stringify(snapshot.state));
      })();
    } catch (error) {
      for (const event of events) {
        if (this.hasEventId(event.eventId)) throw new DuplicateEventError(event.eventId);
      }
      throw error;
    }
  }

  loadSnapshot(sessionId: string): Snapshot | undefined {
    const row = this.db.prepare('SELECT seq, reducerVersion, stateJson FROM snapshots WHERE sessionId = ?')
      .get(sessionId) as SnapshotRow | undefined;
    if (!row) return undefined;
    return {
      seq: row.seq,
      reducerVersion: row.reducerVersion,
      state: JSON.parse(row.stateJson),
    };
  }

  readJournal(sessionId: string, fromSeq = 0): JournalEvent[] {
    const rows = this.db.prepare('SELECT * FROM journal WHERE sessionId = ? AND seq >= ? ORDER BY seq')
      .all(sessionId, fromSeq) as Record<string, unknown>[];
    return rows.map(row => {
      const event: Record<string, unknown> = {
        ...row,
        payload: JSON.parse(row.payload as string),
      };
      if (event.causalParent === null) delete event.causalParent;
      if (event.observedAt === null) delete event.observedAt;
      return event as JournalEvent;
    });
  }

  hasEventId(eventId: string): boolean {
    return this.db.prepare('SELECT 1 FROM journal WHERE eventId = ?').get(eventId) !== undefined;
  }

  writeUsage(row: Usage): void {
    this.db.prepare(`INSERT INTO usage
      (callId, sessionId, role, model, inputTokens, outputTokens, searches, audioSeconds, estimatedUsd)
      VALUES (@callId, @sessionId, @role, @model, @inputTokens, @outputTokens,
        @searches, @audioSeconds, @estimatedUsd)`)
      .run(row);
  }

  pragmas(): Pragmas {
    return {
      journalMode: this.db.pragma('journal_mode', { simple: true }) as string,
      secureDelete: this.db.pragma('secure_delete', { simple: true }) as number,
      foreignKeys: this.db.pragma('foreign_keys', { simple: true }) as number,
    };
  }

  close(): void {
    this.db.close();
  }
}
