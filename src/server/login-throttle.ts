import Database from 'better-sqlite3';

export class LoginThrottle {
  private readonly db: Database.Database;

  constructor(path: string, private readonly now = Date.now) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS login_throttle (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      failures INTEGER NOT NULL,
      locked_until INTEGER NOT NULL
    )`);
  }

  locked(): boolean {
    const row = this.db.prepare('SELECT locked_until FROM login_throttle WHERE id = 1').get() as
      { locked_until: number } | undefined;
    return row !== undefined && row.locked_until > this.now();
  }

  failure(): void {
    const row = this.db.prepare('SELECT failures, locked_until FROM login_throttle WHERE id = 1').get() as
      { failures: number; locked_until: number } | undefined;
    const failures = row && row.locked_until === 0 ? row.failures + 1 : 1;
    const lockedUntil = failures >= 5 ? this.now() + 60_000 : 0;
    this.db.prepare(`INSERT INTO login_throttle (id, failures, locked_until) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`)
      .run(failures, lockedUntil);
  }

  success(): void {
    this.db.prepare('DELETE FROM login_throttle WHERE id = 1').run();
  }

  close(): void {
    this.db.close();
  }
}
