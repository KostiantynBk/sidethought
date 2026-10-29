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
    const state = result.snapshot!.state.domain;
    expect(state.deliveries['s.3.3']?.finalAcknowledged).toBe(true);
    expect(state.deliveries['s.3.3']?.deliveredChars).toBe('So €10 a month, billed yearly?'.length);
    expect(state.items['s.8.1']?.status).toBe('considering');
    expect(result.projection?.decisions).toContainEqual({
      seq: 8,
      kind: 'item',
      reason: 'status:forced_considering:assistant_only',
    });
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
