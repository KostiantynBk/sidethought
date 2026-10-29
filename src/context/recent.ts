import type { Delivery } from '../contract/index.js';
import type { State } from '../kernel/state.js';
import { wholeWordPrefix } from '../kernel/reply-abort.js';

export type RecentTurn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export function sentText(delivery: Delivery): string {
  return delivery.chunks.filter(chunk => ['sent', 'rendered', 'played'].includes(chunk.state))
    .map(chunk => chunk.text).join('');
}

export function deliveredText(delivery: Delivery): string {
  if (delivery.settled && delivery.interruptedPrefix !== undefined) return delivery.interruptedPrefix;
  return wholeWordPrefix(sentText(delivery), delivery.deliveredChars);
}

function order(id: string): [number, number] {
  // Kernel IDs encode acceptance sequence and allocation order (§6.3), not wall-clock time.
  const match = /\.(\d+)\.(\d+)$/.exec(id);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

export function recentTurns(domain: State['domain'], limit: number): RecentTurn[] {
  const turns: RecentTurn[] = domain.inputs.filter(input => (input.origin ?? 'user') === 'user')
    .map(input => ({
      id: input.id,
      role: 'user',
      text: input.text,
    }));
  for (const delivery of Object.values(domain.deliveries)) {
    const text = deliveredText(delivery);
    if (!text) continue;
    turns.push({
      id: delivery.id,
      role: 'assistant',
      text: delivery.state === 'interrupted' ? `[interrupted after: ${text}]` : text,
    });
  }
  return turns.sort((a, b) => {
    const left = order(a.id);
    const right = order(b.id);
    return left[0] - right[0] || left[1] - right[1];
  }).slice(-limit);
}
