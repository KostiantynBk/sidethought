import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { State } from '../kernel/index.js';
import { redactLessonUses } from './redaction.js';
import {
  LessonEdit,
  LessonInput,
  MemoryError,
  ProjectId,
  type LessonDraft,
  type LessonUse,
  type ProjectSpace,
  type SharedLesson,
} from './types.js';

const schema = `
  CREATE TABLE IF NOT EXISTS project_memory_settings (
    projectId TEXT PRIMARY KEY REFERENCES projects(id),
    enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS shared_lessons (
    id TEXT PRIMARY KEY,
    sourceProjectId TEXT NOT NULL REFERENCES projects(id),
    sourceInputId TEXT NOT NULL,
    quote TEXT NOT NULL,
    text TEXT NOT NULL,
    termsJson TEXT NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lesson_uses (
    callId TEXT NOT NULL,
    sessionId TEXT NOT NULL,
    lessonId TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY(callId, lessonId)
  );
`;

type LessonRow = Omit<SharedLesson, 'terms'> & { termsJson: string };
const lessonSelect = `SELECT l.*, p.name AS sourceProjectName
  FROM shared_lessons l JOIN projects p ON p.id = l.sourceProjectId`;
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';

function unpack(row: LessonRow): SharedLesson {
  const { termsJson, ...lesson } = row;
  return { ...lesson, terms: JSON.parse(termsJson) };
}

export class ProjectMemoryStore {
  private readonly db: Database.Database;
  private readonly ownsConnection: boolean;
  storageCleanupPending = false;

  constructor(database: string | Database.Database) {
    this.ownsConnection = typeof database === 'string';
    this.db = typeof database === 'string' ? new Database(database) : database;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('secure_delete = ON');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(schema);
    this.preserveUseAudit();
    this.db.prepare('INSERT OR IGNORE INTO projects (id, name, rev) VALUES (?, ?, 0)')
      .run('local', 'Current project');
    this.db.prepare('INSERT OR IGNORE INTO project_memory_settings (projectId) VALUES (?)').run('local');
  }

  private preserveUseAudit(): void {
    const foreignKeys = this.db.pragma('foreign_key_list(lesson_uses)') as unknown[];
    if (!foreignKeys.length) return;
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE lesson_uses_preserved (
        callId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        lessonId TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY(callId, lessonId)
      )`);
      this.db.exec('INSERT INTO lesson_uses_preserved SELECT callId, sessionId, lessonId, version FROM lesson_uses');
      this.db.exec('DROP TABLE lesson_uses');
      this.db.exec('ALTER TABLE lesson_uses_preserved RENAME TO lesson_uses');
    }).immediate();
  }

  projects(): ProjectSpace[] {
    const rows = this.db.prepare(`SELECT p.id, p.name, COALESCE(s.enabled, 0) AS memoryEnabled
      FROM projects p LEFT JOIN project_memory_settings s ON s.projectId = p.id ORDER BY p.rowid`)
      .all() as Array<{ id: string; name: string; memoryEnabled: number }>;
    return rows.map(row => ({ ...row, memoryEnabled: Boolean(row.memoryEnabled) }));
  }

  project(id: string): ProjectSpace {
    if (!ProjectId.safeParse(id).success) throw new MemoryError(400, 'Invalid project');
    const project = this.projects().find(row => row.id === id);
    if (!project) throw new MemoryError(404, 'Project not found');
    return project;
  }

  createProject(name: string): ProjectSpace {
    if (this.projects().length >= 20) throw new MemoryError(409, 'Prototype limit: 20 projects');
    const id = `project-${randomUUID()}`;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO projects (id, name, rev) VALUES (?, ?, 0)').run(id, name);
      this.db.prepare('INSERT INTO project_memory_settings (projectId) VALUES (?)').run(id);
    })();
    return this.project(id);
  }

  setEnabled(id: string, enabled: boolean): ProjectSpace {
    this.project(id);
    this.db.prepare(`INSERT INTO project_memory_settings (projectId, enabled) VALUES (?, ?)
      ON CONFLICT(projectId) DO UPDATE SET enabled = excluded.enabled`).run(id, Number(enabled));
    return this.project(id);
  }

  lessons(): SharedLesson[] {
    return (this.db.prepare(`${lessonSelect} ORDER BY l.rowid DESC`).all() as LessonRow[]).map(unpack);
  }

  private lesson(id: string): SharedLesson {
    const row = this.db.prepare(`${lessonSelect} WHERE l.id = ?`).get(id) as LessonRow | undefined;
    if (!row) throw new MemoryError(404, 'Lesson not found');
    return unpack(row);
  }

  inputs(projectId: string): Array<{ id: string; text: string; status: string }> {
    this.project(projectId);
    const snapshot = this.db.prepare('SELECT stateJson FROM snapshots WHERE sessionId = ?')
      .get(projectId) as { stateJson: string } | undefined;
    if (!snapshot) return [];
    const state = JSON.parse(snapshot.stateJson) as State;
    return state.domain.inputs.filter(input => (input.origin ?? 'user') === 'user')
      .map(input => ({ id: input.id, text: input.text, status: input.status }));
  }

  private sourceContains(projectId: string, inputId: string, quote: string): boolean {
    return this.inputs(projectId).some(input => input.id === inputId && input.text.includes(quote));
  }

  recentUses(projectId: string): Array<LessonUse & { lessonId: string; version: number }> {
    this.project(projectId);
    const rows = this.db.prepare(`SELECT callId, sessionId, lessonId, version FROM lesson_uses
      WHERE sessionId = ? ORDER BY rowid DESC LIMIT 12`).all(projectId);
    return rows as Array<LessonUse & { lessonId: string; version: number }>;
  }

  createLesson(projectId: string, raw: LessonDraft): SharedLesson {
    this.project(projectId);
    const draft = LessonInput.parse(raw);
    if (!this.sourceContains(projectId, draft.sourceInputId, draft.quote)) {
      throw new MemoryError(409, 'Source quote must match a user message in this project');
    }
    if (this.lessons().length >= 100) throw new MemoryError(409, 'Prototype limit: 100 lessons');
    if (draft.terms.some(term => !normalized(term))) throw new MemoryError(400, 'Use meaningful match terms');
    const id = randomUUID();
    this.db.prepare(`INSERT INTO shared_lessons
      (id, sourceProjectId, sourceInputId, quote, text, termsJson, version) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(id, projectId, draft.sourceInputId, draft.quote, draft.text, JSON.stringify(draft.terms));
    return this.lesson(id);
  }

  retrieve(projectId: string, query: string): SharedLesson[] {
    if (!this.project(projectId).memoryEnabled) return [];
    const haystack = ` ${normalized(query)} `;
    return this.lessons().filter(lesson => lesson.sourceProjectId !== projectId)
      .filter(lesson => this.sourceContains(lesson.sourceProjectId, lesson.sourceInputId, lesson.quote))
      .map(lesson => ({
        lesson,
        score: lesson.terms.filter(term => haystack.includes(` ${normalized(term)} `)).length,
      }))
      .filter(match => match.score > 0)
      .sort((left, right) => right.score - left.score || left.lesson.id.localeCompare(right.lesson.id))
      .slice(0, 3)
      .map(match => match.lesson);
  }

  recordUse(callId: string, sessionId: string, lessons: SharedLesson[]): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO lesson_uses
      (callId, sessionId, lessonId, version) VALUES (?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const lesson of lessons) insert.run(callId, sessionId, lesson.id, lesson.version);
    })();
  }

  uses(id: string): LessonUse[] {
    return this.db.prepare('SELECT callId, sessionId FROM lesson_uses WHERE lessonId = ?')
      .all(id) as LessonUse[];
  }

  changeLesson(id: string, raw: unknown): { lesson: SharedLesson; affected: string[] } {
    const edit = LessonEdit.parse(raw);
    if (edit.terms.some(term => !normalized(term))) throw new MemoryError(400, 'Use meaningful match terms');
    const affected = this.db.transaction(() => {
      if (this.lesson(id).version !== edit.expectedVersion) throw new MemoryError(409, 'Lesson changed; refresh first');
      const sessions = redactLessonUses(this.db, this.uses(id), id);
      const update = this.db.prepare(`UPDATE shared_lessons SET text = ?, termsJson = ?, version = version + 1
        WHERE id = ? AND version = ?`).run(edit.text, JSON.stringify(edit.terms), id, edit.expectedVersion);
      if (update.changes !== 1) throw new MemoryError(409, 'Lesson changed; refresh first');
      return sessions;
    }).immediate();
    this.checkpoint();
    return { lesson: this.lesson(id), affected };
  }

  removeLesson(id: string, expectedVersion: number): string[] {
    const affected = this.db.transaction(() => {
      if (this.lesson(id).version !== expectedVersion) throw new MemoryError(409, 'Lesson changed; refresh first');
      const sessions = redactLessonUses(this.db, this.uses(id), id);
      const removed = this.db.prepare('DELETE FROM shared_lessons WHERE id = ? AND version = ?')
        .run(id, expectedVersion);
      if (removed.changes !== 1) throw new MemoryError(409, 'Lesson changed; refresh first');
      return sessions;
    }).immediate();
    this.checkpoint();
    return affected;
  }

  private checkpoint(): void {
    // Cleanup failure must never prevent live-runner invalidation after a committed mutation.
    this.storageCleanupPending = true;
    try {
      const result = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
      this.storageCleanupPending = result.some(row => row.busy !== 0);
    } catch {
      // Report pending disk cleanup, but always return affected sessions to the runtime.
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }
}
