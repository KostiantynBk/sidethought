import type { Context } from '../state.js';
import { dependencyState } from '../research/policy.js';
import { normalizeEvidence } from '../research/support.js';
import { verifiedClaims } from './candidates.js';
import { decide, topicBlocked, transition, wakeAt } from './common.js';
import { contributionControlBlock } from './cuts.js';
import { startCheck } from './checking.js';
import { beginDelivery, currentCheck } from './delivery.js';
import type { Contribution } from './types.js';

export function floorBlock(context: Context, at: number): string | undefined {
  const domain = context.domain;
  if (!domain.clientConnected) return 'disconnected';
  if (domain.replyPending || domain.reply?.status === 'streaming') return 'reply_pending';
  if (domain.awaitingUserAnswer) return 'answer_wait';
  if (domain.userWait) return 'user_wait';
  if (domain.composerActive) return 'composer';
  if (domain.inputs.some(input => (input.origin ?? 'user') === 'user' && input.status !== 'interpreted')) {
    return 'uninterpreted';
  }
  if (domain.timers.some(timer => timer.purpose === 'replyDebounce')) return 'wait';
  if (Object.values(domain.deliveries).some(delivery => delivery.state === 'delivering'
    && !delivery.finalAcknowledged && !delivery.settled)) return 'delivery';
  const gap = (domain.lastFloorActivity ?? at) + context.config.gapTextMs;
  if (at < gap) {
    wakeAt(context, 'floorGap', gap);
    return 'gap';
  }
  return undefined;
}

function novel(context: Context, candidate: Contribution): boolean {
  if (candidate.payload === 'closure') return true;
  if (topicBlocked(context, candidate.topicKey)) return false;
  const others = Object.values(context.domain.initiative.candidates)
    .filter(value => value.id !== candidate.id && value.state === 'delivered');
  if (others.some(value => value.topicKey === candidate.topicKey)) return false;
  const finding = candidate.source.findingId ? context.domain.findings[candidate.source.findingId] : undefined;
  if (!finding) return true;
  const delivered = new Set(others.flatMap(value => {
    const prior = value.source.findingId ? context.domain.findings[value.source.findingId] : undefined;
    return prior ? verifiedClaims(prior).filter(claim => value.checkedClaims?.includes(claim.id))
      .map(claim => normalizeEvidence(claim.text)) : [];
  }));
  return verifiedClaims(finding).some(claim => !delivered.has(normalizeEvidence(claim.text)));
}

function candidateGate(context: Context, candidate: Contribution, at: number): boolean {
  const invalid = dependencyState(candidate.deps, context.domain.items).removed;
  if (invalid) {
    transition(context, candidate, candidate.payload === 'evidence' ? 'card_only' : 'dropped', `validity:${invalid}`);
    return false;
  }
  if (!novel(context, candidate)) {
    transition(context, candidate, 'dropped', 'novelty');
    return false;
  }
  const last = context.domain.initiative.lastSpeakAt;
  if (last !== null && at < last + context.config.speakSpacingMs) {
    wakeAt(context, 'rateLimit', last + context.config.speakSpacingMs);
    decide(context, 'rate:wait', candidate);
    return false;
  }
  if (candidate.payload !== 'closure' && at >= candidate.expiresAt!) {
    transition(context, candidate, 'card_only', 'freshness:expired');
    return false;
  }
  return true;
}

function prepareDelivery(context: Context, candidate: Contribution, at: number): void {
  if (candidate.payload === 'closure') {
    beginDelivery(context, candidate, at);
    return;
  }
  if (candidate.utterance && !currentCheck(context, candidate)) {
    delete candidate.utterance;
    candidate.rechecks += 1;
    if (candidate.rechecks > Math.min(1, context.config.maxCheckerRechecks)) {
      transition(context, candidate, 'card_only', 'check:revision_card');
      return;
    }
    decide(context, 'check:revision_retry', candidate);
  }
  if (candidate.utterance) beginDelivery(context, candidate, at);
  else startCheck(context, candidate, at);
}

export function arbitrate(context: Context, at: number): void {
  const candidates = Object.values(context.domain.initiative.candidates);
  const pending = candidates.filter(candidate => candidate.state === 'candidate');
  if (!pending.length) return;
  const expiring = pending.filter(candidate => candidate.payload !== 'closure');
  if (expiring.length) wakeAt(context, 'candidateExpiry', Math.max(at, Math.min(...expiring.map(c => c.expiresAt!))));
  if (candidates.some(candidate => candidate.state === 'checking')) return;
  const blocked = contributionControlBlock(context) ?? floorBlock(context, at);
  if (blocked) {
    for (const candidate of pending) decide(context, `floor:${blocked}`, candidate);
    return;
  }
  for (const candidate of pending) {
    if (!candidateGate(context, candidate, at)) continue;
    prepareDelivery(context, candidate, at);
    if (candidate.state === 'checking' || candidate.state === 'delivering') break;
  }
}
