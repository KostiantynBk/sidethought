import { isDeepStrictEqual } from 'node:util';
import type { Delivery, Effect, KernelEvent } from '../contract/index.js';
import type { State } from '../kernel/index.js';
import { assembleContext } from '../context/index.js';
import { recentTurns } from '../context/recent.js';

function sent(delivery: Delivery): string {
  return delivery.chunks.filter(chunk => ['sent', 'rendered', 'played'].includes(chunk.state))
    .map(chunk => chunk.text).join('');
}

function acknowledged(delivery: Delivery): string {
  return sent(delivery).slice(0, delivery.deliveredChars);
}

// Independent D3 oracle: inspect the pre-trim suffix, not the production trimming helper.
function interruptionProblems(before: State, after: State): string[] {
  const problems: string[] = [];
  for (const [id, current] of Object.entries(after.domain.deliveries)) {
    const previous = before.domain.deliveries[id];
    if (!previous || previous.settled || !current.settled || current.interruptedPrefix === undefined) continue;
    const full = sent(previous);
    const raw = full.slice(0, current.deliveredChars);
    const cutsWord = current.deliveredChars < full.length
      && !/\s/u.test(full[current.deliveredChars]!) && !/\s$/u.test(raw);
    const expected = (cutsWord ? raw.replace(/\S+$/u, '') : raw).trimEnd();
    if (current.interruptedPrefix !== expected) problems.push('I9 interrupted marker cuts a word');
  }
  return problems;
}

function checkLedger(delivery: Delivery): string[] {
  const problems: string[] = [];
  const raw = acknowledged(delivery);
  if (delivery.interruptedPrefix !== undefined && !raw.startsWith(delivery.interruptedPrefix)) {
    problems.push('I9 interrupted marker contains undelivered text');
  }
  let end = 0;
  const claims = new Set<string>();
  for (const chunk of delivery.chunks) {
    if (!['sent', 'rendered', 'played'].includes(chunk.state)) continue;
    const sentenceEnd = end + chunk.text.trimEnd().length;
    end += chunk.text.length;
    if (chunk.sentenceFinished && delivery.deliveredChars >= sentenceEnd) {
      for (const claim of chunk.claimIds) claims.add(claim);
    }
  }
  if (!isDeepStrictEqual([...claims].sort(), [...delivery.claimsDelivered].sort())) {
    problems.push('I9 claim accounting differs from completed delivered sentences');
  }
  if (delivery.deliveredChars > end) problems.push('I9 delivered count exceeds retained sent text');
  return problems;
}

type Turn = { id: string; role: string; text: string };
function checkTurns(state: State, turns: Turn[]): string[] {
  const problems: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    const delivery = state.domain.deliveries[turn.id];
    if (!delivery) {
      problems.push('I9 context has an assistant turn outside the ledger');
      continue;
    }
    const raw = acknowledged(delivery);
    const marker = turn.text.startsWith('[interrupted after: ') && turn.text.endsWith(']');
    const text = marker ? turn.text.slice('[interrupted after: '.length, -1) : turn.text;
    const full = sent(delivery);
    if (!raw.startsWith(text) || (text.length < full.length && text.length > 0 && !/\s/u.test(full[text.length]!))) {
      problems.push('I9 context contains undelivered assistant text');
    }
    // A partial word may be omitted, but no interior whitespace permits trimming whole delivered words.
    if (text !== raw.trimEnd() && /\s/u.test(raw.slice(text.length).trim())) {
      problems.push('I9 context marker is not the delivered whole-word prefix');
    }
  }
  return problems;
}

export function deliveredContextInvariant(
  before: State,
  _event: KernelEvent,
  after: State,
  effects: Effect[],
): string[] {
  const problems = Object.values(after.domain.deliveries).flatMap(checkLedger);
  problems.push(...interruptionProblems(before, after));
  problems.push(...checkTurns(after, recentTurns(after.domain, after.config.recentWindowTurns)));
  for (const effect of effects) {
    if (effect.type !== 'llm.call' || !['interpreter', 'responder'].includes(effect.role)) continue;
    try {
      const prompt = JSON.parse(assembleContext(after, effect).input) as { recentWindow: Turn[] };
      problems.push(...checkTurns(after, prompt.recentWindow));
    } catch (error) {
      // A stale capture is intentionally an assembly error, not a silent substitution (A2).
      if (!(error instanceof Error) || !error.message.startsWith('context:capture_mismatch:')) {
        problems.push(`I9 context assembly failed: ${String(error)}`);
      }
    }
  }
  return problems;
}
