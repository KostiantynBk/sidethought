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

it('replays soft-wait-cap with overriding input IDs and sent sentence ledger on both stores', () => {
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
  expect(result.projection?.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(true);
});

it('replays owner-only-clears-reply with retired done and failed leaving the new reply pending on both stores', () => {
  const result = replay('owner-only-clears-reply');
  const domain = result.snapshot!.state.domain;
  expect(domain.replyPending).toBe(true);
  expect(domain.reply?.callId).toBe('s.8.2');
  expect(domain.reply?.status).toBe('streaming');
  expect(domain.deliveries['s.8.3']?.chunks[0]?.text).toBe('Current sentence. ');
  expect(result.projection?.decisions.slice(-2).map(decision => decision.reason))
    .toEqual(['late:retired_reply', 'late:retired_reply']);
});

it('replays s3-abort-renderedupto through the new reply without forwarding G12 after the commit', () => {
  const result = replay('s3-abort-renderedupto');
  const domain = result.snapshot!.state.domain;
  expect(domain.deliveries['s.3.3']?.deliveredChars).toBe(41);
  expect(domain.deliveries['s.3.3']?.interruptedPrefix).toBe('For a cloud-backed version, the next');
  expect(domain.reply?.status).toBe('done');
  expect(domain.replyPending).toBe(false);
  expect(result.projection?.effects.filter(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk' && effect.message.deliveryId === 's.3.3')).toHaveLength(1);
});

it('replays s3g-interrupt-mid-number with a whole-word prefix', () => {
  const result = replay('s3g-interrupt-mid-number');
  const delivery = result.snapshot!.state.domain.deliveries['s.3.3']!;
  expect(delivery.chunks[0]?.text).toBe('Provider B costs $1');
  expect(delivery.interruptedPrefix).toBe('Provider B costs');
});

it('replays late-chunk-after-abort with I3 and inert late chunk, done and failed events', () => {
  const result = replay('late-chunk-after-abort');
  const domain = result.snapshot!.state.domain;
  expect(domain.reply?.status).toBe('aborted');
  expect(domain.replyPending).toBe(true);
  expect(result.projection?.decisions.slice(-3).map(decision => decision.reason))
    .toEqual(['late:retired_reply', 'late:retired_reply', 'late:retired_reply']);
  expect(result.projection?.effects.filter(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toHaveLength(1);
});

it('replays output-check-credential without sending the request and with a fixed notice', () => {
  const result = replay('output-check-credential');
  expect(result.snapshot!.state.domain.replyPending).toBe(false);
  expect(result.projection?.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(false);
  expect(result.projection?.effects).toContainEqual({
    type: 'client.send',
    message: {
      type: 'transcript.appended',
      text: 'I stopped this reply because it failed an output safety check.',
    },
  });
});
