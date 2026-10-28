import { expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';

function replay(name: string) {
  const path = `fixtures/t07/${name}.json`;
  const memory = replayFixture(path, { store: 'memory' });
  const sqlite = replayFixture(path, { store: 'sqlite' });
  expect(memory.failures).toEqual([]);
  expect(sqlite.failures).toEqual([]);
  expect(memory.ok).toBe(true);
  expect(sqlite.ok).toBe(true);
  expect(sqlite.projection).toEqual(memory.projection);
  expect(memory.snapshot).toBeDefined();
  expect(sqlite.snapshot).toEqual(memory.snapshot);
  expect(memory.unflushedTelemetry).toEqual([]);
  expect(sqlite.unflushedTelemetry).toEqual([]);
  return memory;
}

it('replays soft-wait-cap with overriding input IDs and pending sentence ledger on both stores', () => {
  const result = replay('soft-wait-cap');
  const domain = result.snapshot!.state.domain;
  expect(domain.reply?.overridesSnapshotInputIds).toEqual(['s.1.1']);
  expect(domain.reply?.basisRev).toBe(0);
  expect(domain.reply?.callId).toBe('s.3.2');
  expect(domain.replyPending).toBe(true);
  expect(result.trace?.filter(event => event.type === 'timer.fired').map(event => event.at)).toEqual([800, 1400]);
  expect(domain.deliveries['s.3.3']?.chunks[0]?.text).toBe('A complete sentence. ');
  expect(domain.deliveries['s.3.3']?.deliveredChars).toBe(0);
  expect(domain.deliveries['s.3.3']?.claimsDelivered).toEqual([]);
  expect(result.projection?.effects.some(effect => effect.type === 'client.send')).toBe(false);
});

it('replays owner-only-clears-reply with retired done and failed leaving the new reply pending on both stores', () => {
  const result = replay('owner-only-clears-reply');
  const domain = result.snapshot!.state.domain;
  expect(domain.replyPending).toBe(true);
  expect(domain.reply?.callId).toBe('s.7.2');
  expect(domain.reply?.status).toBe('streaming');
  expect(domain.deliveries['s.7.3']?.chunks[0]?.text).toBe('Current sentence. ');
  expect(result.projection?.decisions.slice(-2).map(decision => decision.reason))
    .toEqual(['late:retired_reply', 'late:retired_reply']);
});
