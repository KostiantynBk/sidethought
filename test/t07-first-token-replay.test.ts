import { expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';

it('replays a first-token timeout and successful retry with invariants on both stores', () => {
  const path = 'fixtures/t07/first-token-timeout-retry.json';
  const memory = replayFixture(path, { store: 'memory' });
  const sqlite = replayFixture(path, { store: 'sqlite' });
  expect(memory.failures).toEqual([]);
  expect(sqlite.failures).toEqual([]);
  expect(memory.ok).toBe(true);
  expect(sqlite.ok).toBe(true);
  expect(sqlite.projection).toEqual(memory.projection);
  expect(sqlite.snapshot).toEqual(memory.snapshot);
  expect(memory.unflushedTelemetry).toEqual([]);
  expect(sqlite.unflushedTelemetry).toEqual([]);
  const calls = memory.projection!.effects.filter(effect => effect.type === 'llm.call'
    && effect.role === 'responder');
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ requestId: 's.3.1', callId: 's.3.2' });
  expect(calls[1]).toMatchObject({ requestId: 's.3.1', callId: 's.4.1' });
  expect(memory.projection!.decisions.map(decision => decision.reason)).toContain('reply:retry');
  const domain = memory.snapshot!.state.domain;
  expect(domain.reply?.attempt).toBe(2);
  expect(domain.reply?.status).toBe('done');
  expect(domain.replyPending).toBe(false);
  expect(domain.deliveries['s.4.2']?.finalAcknowledged).toBe(true);
  expect(domain.deliveries['s.4.2']?.deliveredChars).toBe('Retry succeeded.'.length);
  expect(domain.deliveries['s.4.2']?.chunks[0]?.text).toBe('Retry succeeded.');
});
