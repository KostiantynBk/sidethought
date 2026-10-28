import { describe, expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';

const directory = 'fixtures/t05';
describe('T05 replay fixtures', () => {
  it('replays the combined hedge', () => {
    const result = replayFixture(`${directory}/items-s5-hedge.json`, { store: 'memory' });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
  it('replays assistant-only wording', () => {
    const result = replayFixture(`${directory}/items-5c-assistant-only.json`, { store: 'memory' });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
  it('replays a question without stating a preference', () => {
    const result = replayFixture(`${directory}/items-5d-question.json`, { store: 'memory' });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
  it('replays an agreement followed by a UI confirm', () => {
    const result = replayFixture(`${directory}/items-2c-2d-confirm.json`, { store: 'memory' });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
