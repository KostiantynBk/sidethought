import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { z } from 'zod';

describe('dependency smoke tests', () => {
  it('parses a trivial zod schema', () => {
    expect(z.object({ value: z.number() }).parse({ value: 1 })).toEqual({ value: 1 });
  });

  it('opens an in-memory SQLite database and runs queries', () => {
    const db = new Database(':memory:');
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
      expect(db.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
    } finally {
      db.close();
    }
  });
});
