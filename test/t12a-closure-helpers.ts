import { expect } from 'vitest';
import { verifiedClaims } from '../src/kernel/contributions/candidates.js';
import type { ResearchHarness } from './t11a-helpers.js';

function fire(h: ResearchHarness, purpose: string): void {
  const timer = h.state.domain.timers.find(value => value.purpose === purpose);
  expect(timer, `missing ${purpose} timer`).toBeDefined();
  h.at = Math.max(h.at, timer!.dueAt - 1);
  h.send('timer.fired', { timerId: timer!.timerId, purpose });
}

export function deliverPromises(h: ResearchHarness, jobIds: string[]): void {
  if (!h.state.domain.clientConnected) h.send('client.connected', { modality: 'text' });
  if (h.state.domain.replyPending) {
    if (h.state.domain.reply?.status !== 'streaming') fire(h, 'replyDebounce');
    const reply = h.state.domain.reply!;
    h.send('reply.chunk', { requestId: reply.requestId, callId: reply.callId, text: '[PASS]' });
    h.send('reply.done', { requestId: reply.requestId, callId: reply.callId });
  }
  for (let steps = 0; steps < 100 && jobIds.some(id => !h.state.domain.jobs[id]?.closureCount); steps += 1) {
    const checking = Object.values(h.state.domain.initiative.candidates).find(c => c.state === 'checking');
    if (checking?.check) {
      const finding = h.state.domain.findings[checking.source.findingId!];
      const claim = verifiedClaims(finding!)[0]!;
      h.send('check.ready', {
        requestId: checking.check.requestId,
        callId: checking.check.callId,
        output: { applies: true, reason: 'Current', utterance: claim.text, claimsUsed: [claim.id] },
      });
      continue;
    }
    const delivering = Object.values(h.state.domain.initiative.candidates).find(c => c.state === 'delivering');
    if (delivering) {
      const delivery = h.state.domain.deliveries[delivering.deliveryId!]!;
      h.send('delivery.progress', {
        deliveryId: delivery.id,
        chunkIdx: delivery.chunks.findLastIndex(chunk => chunk.state === 'sent'),
        chars: delivery.sentChars,
        final: !!delivery.doneSent,
        reason: 'rendered',
      });
      continue;
    }
    const timer = h.state.domain.timers.find(value => ['floorGap', 'rateLimit'].includes(value.purpose));
    expect(timer, 'no floor/rate timer for promised delivery').toBeDefined();
    fire(h, timer!.purpose);
  }
  // Fixed closures count on first chunk, but test helpers also acknowledge them.
  for (const candidate of Object.values(h.state.domain.initiative.candidates)) {
    if (candidate.state !== 'delivering' || !jobIds.includes(candidate.jobId ?? '')) continue;
    const delivery = h.state.domain.deliveries[candidate.deliveryId!]!;
    h.send('delivery.progress', {
      deliveryId: delivery.id,
      chunkIdx: delivery.chunks.findLastIndex(chunk => chunk.state === 'sent'),
      chars: delivery.sentChars,
      final: !!delivery.doneSent,
      reason: 'rendered',
    });
  }
  for (const id of jobIds) {
    expect(h.state.domain.jobs[id]?.closureCount).toBe(1);
    const sent = Object.values(h.state.domain.initiative.candidates)
      .filter(c => c.jobId === id && c.state === 'delivered');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload === 'evidence' || sent[0]!.payload === 'closure').toBe(true);
  }
}
