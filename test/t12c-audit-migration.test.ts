import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ProjectMemoryStore } from '../src/memory/store.js';

it('migrates an existing cascading use table without losing audit records', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE shared_lessons (
      id TEXT PRIMARY KEY, sourceProjectId TEXT NOT NULL, sourceInputId TEXT NOT NULL,
      quote TEXT NOT NULL, text TEXT NOT NULL, termsJson TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE lesson_uses (
      callId TEXT NOT NULL, sessionId TEXT NOT NULL,
      lessonId TEXT NOT NULL REFERENCES shared_lessons(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, PRIMARY KEY(callId, lessonId)
    );
    INSERT INTO projects VALUES ('local', 'Memory A', 0);
    INSERT INTO shared_lessons VALUES ('lesson', 'local', 'input', 'quote', 'text', '[]', 1);
    INSERT INTO lesson_uses VALUES ('call', 'local', 'lesson', 1);
  `);
  const memory = new ProjectMemoryStore(db);
  expect(memory.recentUses('local')).toEqual([{ callId: 'call', sessionId: 'local', lessonId: 'lesson', version: 1 }]);
  db.prepare('DELETE FROM shared_lessons WHERE id = ?').run('lesson');
  expect(memory.recentUses('local')).toHaveLength(1);
  db.close();
});
