import type { Delivery, KernelEvent } from '../../contract/index.js';
import type { Context } from '../state.js';
import { recordPrefix } from '../reply-abort.js';
import { dependencyState } from '../research/policy.js';
import { arm, clearTimer, transition } from './common.js';
import { sentences } from './checking.js';
import type { Contribution } from './types.js';
import { reconcilePromise, sentenceClaims } from './promise.js';

export function currentCheck(context: Context, candidate: Contribution): boolean {
  return candidate.payload === 'closure' || (candidate.checkedAtRev === context.domain.projectRev
    && candidate.checkedInputCount === context.domain.inputs.length);
}

function chunkAllowed(context: Context, candidate: Contribution): boolean {
  const validity = dependencyState(candidate.deps, context.domain.items);
  return !validity.removed && !validity.edited.length && currentCheck(context, candidate)
    && !context.domain.composerActive && !context.domain.replyPending
    && !context.domain.inputs.some(input => (input.origin ?? 'user') === 'user' && input.status !== 'interpreted');
}

export function sendNext(context: Context, candidate: Contribution): void {
  const delivery = context.domain.deliveries[candidate.deliveryId!];
  if (!delivery || delivery.aborted || candidate.state !== 'delivering') return;
  if (!chunkAllowed(context, candidate)) {
    stopContribution(context, candidate, 'basis_changed');
    return;
  }
  const index = delivery.chunks.findIndex(chunk => chunk.state === 'pending');
  if (index < 0) return;
  const chunk = delivery.chunks[index]!;
  chunk.state = 'sent';
  delivery.sentChars += chunk.text.length;
  reconcilePromise(context, candidate, delivery);
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'assistant.chunk',
      deliveryId: delivery.id,
      chunkIdx: index,
      text: chunk.text,
    },
  });
  if (index === delivery.chunks.length - 1) {
    delivery.doneSent = true;
    context.effects.push({
      type: 'client.send',
      message: {
        type: 'assistant.done',
        deliveryId: delivery.id,
        chunkCount: delivery.chunks.length,
      },
    });
  }
}

export function clearCommitOffsetOwner(context: Context): void {
  for (const delivery of Object.values(context.domain.deliveries)) delete delivery.awaitingCommitOffset;
}

export function beginDelivery(context: Context, candidate: Contribution, at: number): void {
  clearCommitOffsetOwner(context);
  const id = context.id();
  const text = candidate.payload === 'closure' ? candidate.text : candidate.utterance!;
  const parts = sentences(text);
  const claims = sentenceClaims(context, candidate, parts);
  const delivery: Delivery = {
    id,
    candidateId: candidate.id,
    callId: candidate.checkCallId ?? context.id(),
    basisRev: context.domain.projectRev,
    state: 'delivering',
    chunks: parts.map((part, index) => ({
      text: part,
      state: 'pending',
      claimIds: claims[index]!,
      sentenceFinished: true,
    })),
    deliveredChars: 0,
    sentChars: 0,
    finalAcknowledged: false,
    aborted: false,
    claimsDelivered: [],
  };
  candidate.deliveryId = id;
  context.domain.deliveries[id] = delivery;
  transition(context, candidate, 'delivering', 'deliver:started');
  context.domain.initiative.lastSpeakAt = at;
  sendNext(context, candidate);
}

export function finishContribution(context: Context, candidate: Contribution, at: number): void {
  transition(context, candidate, 'delivered', 'deliver:acknowledged');
  if (candidate.payload === 'clarification') context.domain.initiative.askedTopics.push(candidate.topicKey);
  context.domain.lastFloorActivity = at;
  const delivery = context.domain.deliveries[candidate.deliveryId!]!;
  const text = delivery.chunks.map(chunk => chunk.text).join('');
  if (/\?\s*$/u.test(text)) {
    context.domain.awaitingUserAnswer = true;
    for (const timer of context.domain.timers.filter(value => value.purpose === 'answerWait')) {
      clearTimer(context, timer.timerId);
    }
    arm(context, 'answerWait', at + context.config.answerWaitMs);
  }
}

export function contributionProgress(
  context: Context,
  event: Extract<KernelEvent, { type: 'delivery.progress' }>,
): void {
  const delivery = context.domain.deliveries[event.payload.deliveryId];
  const candidate = delivery?.candidateId ? context.domain.initiative.candidates[delivery.candidateId] : undefined;
  if (!delivery || !candidate || candidate.state !== 'delivering') return;
  reconcilePromise(context, candidate, delivery);
  if (delivery.finalAcknowledged) finishContribution(context, candidate, event.acceptedAt!);
  else if (delivery.deliveredChars === delivery.sentChars) sendNext(context, candidate);
}

export function stopContribution(
  context: Context,
  candidate: Contribution,
  reason: string,
  renderedUpTo?: number,
  preserveSent = false,
): void {
  const delivery = candidate.deliveryId ? context.domain.deliveries[candidate.deliveryId] : undefined;
  if (!delivery || delivery.settled) return;
  // Keep possibly-rendered text until an authoritative offset can settle an interrupted send.
  recordPrefix(delivery, renderedUpTo, preserveSent || renderedUpTo === undefined);
  if (reason === 'interrupted' && renderedUpTo === undefined) {
    clearCommitOffsetOwner(context);
    delivery.awaitingCommitOffset = true;
  }
  reconcilePromise(context, candidate, delivery);
  candidate.deliveredPrefix = delivery.interruptedPrefix;
  candidate.interruptions += 1;
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'assistant.stopped',
      deliveryId: delivery.id,
      reason,
    },
  });
  if (candidate.payload === 'closure' || preserveSent) {
    transition(context, candidate, 'card_only', `deliver:${reason}`);
  } else {
    transition(context, candidate, 'interrupted', `deliver:${reason}`);
  }
}

export function interruptContributions(context: Context, reason: string, renderedUpTo?: number): void {
  // Presentation may already be card_only, and prior progress may already be incomplete.
  // Ownership, not presentation/witness state or insertion order, binds this commit offset.
  const owner = Object.values(context.domain.deliveries).find(delivery => delivery.awaitingCommitOffset);
  const interrupted = owner?.candidateId ? context.domain.initiative.candidates[owner.candidateId] : undefined;
  if (owner && interrupted && renderedUpTo !== undefined) {
    delete owner.awaitingCommitOffset;
    recordPrefix(owner, renderedUpTo);
    reconcilePromise(context, interrupted, owner);
    interrupted.deliveredPrefix = owner.interruptedPrefix;
  }
  for (const candidate of Object.values(context.domain.initiative.candidates)) {
    if (candidate.state === 'delivering') stopContribution(context, candidate, reason, renderedUpTo);
  }
}
