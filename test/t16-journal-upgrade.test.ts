import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState, reduce } from '../src/kernel/index.js';
import { ProjectUpgradeError, REDUCER_VERSION, SessionRunner } from '../src/runtime/session-runner.js';
import { SqliteStore } from '../src/store/sqlite.js';
import { createRuntime } from '../src/server/runtime.js';
import { serverConfig } from '../src/server/config.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sidethought-t16-'));
  const path = join(dir, 'test.sqlite');
  const store = new SqliteStore(path);
  const memory = store.projectMemory();
  const sql = new Database(path);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => store.close());
  cleanup.push(() => sql.close());
  return { path, store, memory, sql };
}

function runner(store: SqliteStore, id: string, effects: string[] = []) {
  return new SessionRunner(id, loadConfig(), store, () => 100, batch => effects.push(...batch.map(e => e.type)));
}

function input(store: SqliteStore, id: string) {
  const r = runner(store, id);
  r.accept({
    eventId: `${id}-input`,
    sessionId: id,
    type: 'input.committed',
    payload: { clientMsgId: `${id}-msg`, text: 'forecasting on this laptop', modality: 'text' },
  });
  return r;
}

function age(sql: Database.Database, id: string) {
  sql.prepare('UPDATE snapshots SET reducerVersion = ?, stateJson = ? WHERE sessionId = ?')
    .run('9', JSON.stringify(initialState(id, loadConfig())), id);
}

function journal(sql: Database.Database, id: string) {
  return sql.prepare('SELECT * FROM journal WHERE sessionId = ? ORDER BY seq').all(id);
}

function lessonSetup() {
  const env = setup();
  const source = input(env.store, 'local');
  const target = env.memory.createProject('Target');
  input(env.store, target.id);
  const lesson = env.memory.createLesson('local', {
    sourceInputId: source.current().domain.inputs[0]!.id,
    quote: 'forecasting on this laptop',
    text: 'Use this laptop.',
    terms: ['forecasting'],
    confirmed: true,
  });
  env.memory.setEnabled(target.id, true);
  return { ...env, source, target, lesson };
}

describe('T16 journal upgrade', () => {
  it('rebuilds from the complete journal, then recovers without modifying existing journal rows', () => {
    const { store, sql } = setup();
    input(store, 'local');
    const events = store.readJournal('local');
    const expected = events.reduce((state, event) => reduce(state, event).state, initialState('local', loadConfig()));
    const before = journal(sql, 'local');
    age(sql, 'local');
    const observed: string[] = [];
    const upgraded = runner(store, 'local', observed);
    upgraded.recover('recovery');
    const rebuilt = reduce(expected, {
      eventId: 'recovery', sessionId: 'local', type: 'session.recovered', acceptedAt: 100, payload: {},
    }).state;
    expect(upgraded.current()).toEqual(rebuilt);
    expect(store.loadSnapshot('local')?.reducerVersion).toBe(REDUCER_VERSION);
    expect(journal(sql, 'local').slice(0, before.length)).toEqual(before);
    expect(observed).not.toContain('llm.call');
    expect(observed).not.toContain('job.dispatch');
    expect(observed).not.toContain('client.send');
    expect(upgraded.current().domain.call).toBeNull();
  });

  it('makes one valid backup before the first upgrade and does not replace it', () => {
    const { store, path, sql } = setup();
    input(store, 'local');
    age(sql, 'local');
    runner(store, 'local').recover('recovery');
    const backup = `${path}.pre-v${REDUCER_VERSION}.bak`;
    expect(existsSync(backup)).toBe(true);
    const copy = new Database(backup, { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect((copy.prepare('SELECT reducerVersion FROM snapshots WHERE sessionId = ?').get('local') as
      { reducerVersion: string }).reducerVersion).toBe('9');
    copy.close();
    const first = statSync(backup).mtimeMs;
    age(sql, 'local');
    runner(store, 'local').recover('recovery-again');
    expect(statSync(backup).mtimeMs).toBe(first);
  });

  it('refuses an invalid event without touching the project and permits another project to recover', () => {
    const { store, memory, sql } = setup();
    input(store, 'local');
    const other = memory.createProject('Other');
    input(store, other.id);
    age(sql, 'local');
    sql.prepare("UPDATE journal SET payload = '{}' WHERE sessionId = ?").run('local');
    const before = journal(sql, 'local');
    const snapshot = sql.prepare('SELECT * FROM snapshots WHERE sessionId = ?').get('local');
    expect(() => runner(store, 'local').recover('failed')).toThrow(ProjectUpgradeError);
    expect(journal(sql, 'local')).toEqual(before);
    expect(sql.prepare('SELECT * FROM snapshots WHERE sessionId = ?').get('local')).toEqual(snapshot);
    expect(() => runner(store, other.id).recover('other-recovery')).not.toThrow();
  });

  it('retains a reviewed lesson from an upgraded source for an opted-in target', () => {
    const { store, sql, memory, target, lesson } = lessonSetup();
    age(sql, 'local');
    runner(store, 'local').recover('source-recovery');
    expect(memory.retrieve(target.id, 'forecasting')).toEqual([lesson]);
  });

  it('refuses a project that used an edited lesson without touching its rows', () => {
    const { store, sql, memory, target, lesson } = lessonSetup();
    memory.recordUse(`${target.id}.1.1`, target.id, [lesson]);
    memory.changeLesson(lesson.id, {
      text: 'Changed.', terms: ['forecasting'], expectedVersion: 1, acknowledgeRedaction: true,
    });
    age(sql, target.id);
    const before = journal(sql, target.id);
    const snapshot = sql.prepare('SELECT * FROM snapshots WHERE sessionId = ?').get(target.id);
    expect(() => runner(store, target.id).recover('refused')).toThrow(/lesson it used was later changed/);
    expect(journal(sql, target.id)).toEqual(before);
    expect(sql.prepare('SELECT * FROM snapshots WHERE sessionId = ?').get(target.id)).toEqual(snapshot);
  });

  it('refuses a project that used a forgotten lesson', () => {
    const { store, sql, memory, target, lesson } = lessonSetup();
    memory.recordUse(`${target.id}.1.1`, target.id, [lesson]);
    memory.removeLesson(lesson.id, 1);
    age(sql, target.id);
    expect(() => runner(store, target.id).recover('refused')).toThrow(/lesson it used was later changed/);
  });

  it('upgrades a project that used an unchanged lesson', () => {
    const { store, sql, memory, target, lesson } = lessonSetup();
    memory.recordUse(`${target.id}.1.1`, target.id, [lesson]);
    age(sql, target.id);
    expect(() => runner(store, target.id).recover('target-recovery')).not.toThrow();
  });

  it('upgrades the source project after its lesson is edited', () => {
    const { store, sql, memory, lesson } = lessonSetup();
    memory.changeLesson(lesson.id, {
      text: 'Changed.', terms: ['forecasting'], expectedVersion: 1, acknowledgeRedaction: true,
    });
    age(sql, 'local');
    expect(() => runner(store, 'local').recover('source-recovery')).not.toThrow();
  });

  it('reports an invalid local project in the project list while another project loads', async () => {
    const { store, path, sql, memory } = setup();
    input(store, 'local');
    const other = memory.createProject('Other');
    input(store, other.id);
    age(sql, 'local');
    sql.prepare("UPDATE journal SET payload = '{}' WHERE sessionId = ?").run('local');
    const config = serverConfig({
      SIDETHOUGHT_PASSCODE: 'test-only-passcode',
      SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
      SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      SIDETHOUGHT_DB_PATH: path,
      SIDETHOUGHT_MODEL: 'dev',
    });
    const runtime = await createRuntime(config);
    try {
      const login = await runtime.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const response = await runtime.app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const projects = response.json().projects as Array<{ id: string; upgradeStatus?: string }>;
      expect(projects.find(project => project.id === 'local')?.upgradeStatus).toMatch(/can't be upgraded/);
      expect(projects.find(project => project.id === other.id)?.upgradeStatus).toBeUndefined();
      expect(runtime.projectRunner(other.id).current().sessionId).toBe(other.id);
    } finally {
      await runtime.close();
    }
  });

  it('does not create a backup on the current-version path', () => {
    const { store, path } = setup();
    input(store, 'local');
    runner(store, 'local').recover('recovery');
    expect(existsSync(`${path}.pre-v${REDUCER_VERSION}.bak`)).toBe(false);
  });
});
