import { isDeepStrictEqual } from 'node:util';
import type { KernelEvent, Effect } from '../contract/index.js';
import { hasUninterpretedInput, type State, type Decision } from '../kernel/index.js';
import { validateSpans, type QuoteInput } from '../kernel/items/index.js';
import { deliveredContextInvariant } from './context-invariant.js';
import { deliveredQuoteInputs } from '../context/quote-sources.js';
import { I11, promised_closed_once, researchEvidence, retiredResearch } from './research-invariants.js';

import { I1, I2, I4, I12, I14, I17 } from './contribution-invariants.js';

type Invariant = (
  before: State,
  event: KernelEvent,
  after: State,
  effects: Effect[],
  decisions: Decision[],
) => string[];

function duplicateReason(before: State, event: KernelEvent): string | undefined {
  if (before.meta.eventIds.includes(event.eventId)) return 'dup:eventId';
  if (event.type === 'input.committed' && before.meta.clientMsgIds.includes(event.payload.clientMsgId)) {
    return 'dup:clientMsgId';
  }
  return undefined;
}

function inertResult(
  before: State,
  after: State,
  effects: Effect[],
  decisions: Decision[],
  reason: string,
): boolean {
  const expected = [{
    seq: before.meta.seq + 1,
    kind: 'kernel',
    reason,
  }];
  return isDeepStrictEqual(before.domain, after.domain)
    && effects.length === 0
    && isDeepStrictEqual(decisions, expected);
}

const sequence: Invariant = (before, _event, after) =>
  after.meta.seq === before.meta.seq + 1 ? [] : ['sequence must advance exactly once'];

const idempotency: Invariant = (before, event, after, effects, decisions) => {
  const reason = duplicateReason(before, event);
  if (!reason || inertResult(before, after, effects, decisions, reason)) return [];
  return ['I6 duplicate violated domain, effect or decision contract'];
};

const retiredAttempt: Invariant = (before, event, after, effects, decisions) => {
  if (duplicateReason(before, event)) return [];
  if (event.type !== 'interpretation.ready' && event.type !== 'interpretation.failed') return [];
  const call = before.domain.call;
  const late = !call || call.callId !== event.payload.callId || call.requestId !== event.payload.requestId;
  if (!late || inertResult(before, after, effects, decisions, 'late:retired_attempt')) return [];
  return ['I18 retired attempt violated domain, effect or decision contract'];
};

const captures: Invariant = (before, _event, after, effects) => {
  const violations: string[] = [];
  for (const effect of effects) {
    if (effect.type !== 'llm.call' || effect.role !== 'interpreter') continue;
    const prior = before.domain.call;
    const expected = prior?.requestId === effect.requestId
      ? prior.capturedInputs
      : Object.values(after.domain.items).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(item => ({
        itemId: item.id,
        contentVersion: item.contentVersion,
      }));
    if (!isDeepStrictEqual(effect.capturedInputs, expected)
      || !isDeepStrictEqual(after.domain.call?.capturedInputs, expected)) {
      violations.push('I18 captured versions differ from dispatch basis');
    }
  }
  return violations;
};

// T04 hook for the future arbiter: a disconnected client cannot receive a contribution floor grant.
export function disconnectedFloorViolation(state: State, contributionGranted: boolean): string[] {
  return !state.domain.clientConnected && contributionGranted ? ['floor granted while client disconnected'] : [];
}

const retiredReplyResult: Invariant = (before, event, after, effects, decisions) => {
  if (duplicateReason(before, event)) return [];
  if (event.type !== 'reply.chunk' && event.type !== 'reply.done' && event.type !== 'reply.failed') return [];
  const reply = before.domain.reply;
  const late = !reply || reply.status !== 'streaming'
    || reply.callId !== event.payload.callId || reply.requestId !== event.payload.requestId;
  if (!late || inertResult(before, after, effects, decisions, 'late:retired_reply')) return [];
  return ['reply owner: retired result changed domain, effects or decision'];
};

const replyCaptures: Invariant = (_before, _event, after, effects) => {
  for (const effect of effects) {
    if (effect.type !== 'llm.call' || effect.role !== 'responder') continue;
    if (after.domain.composerActive) return ['reply start while composer active'];
    const reply = after.domain.reply;
    const expected = Object.values(after.domain.items).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(item => ({
        itemId: item.id,
        contentVersion: item.contentVersion,
      }));
    if (!isDeepStrictEqual(effect.capturedInputs, expected)
      || !isDeepStrictEqual(reply?.capturedInputs, expected)
      || reply?.basisRev !== after.domain.projectRev || effect.basisRev !== reply.basisRev) {
      return ['reply capture: dispatch differs from snapshot basis'];
    }
  }
  return [];
};

const noPostAbortChunks: Invariant = (before, _event, after, effects) => {
  const aborted = new Set(Object.values(before.domain.deliveries)
    .filter(delivery => delivery.aborted).map(delivery => delivery.callId));
  for (const effect of effects) {
    if (effect.type === 'llm.abort') aborted.add(effect.callId);
    if (effect.type !== 'client.send' || effect.message.type !== 'assistant.chunk') continue;
    const delivery = after.domain.deliveries[effect.message.deliveryId];
    if (delivery && aborted.has(delivery.callId)) return ['I3 chunk forwarded after generation abort'];
  }
  return [];
};

export const invariantRegistry: Invariant[] = [
  I1,
  I2,
  I4,
  I12,
  I14,
  I17,
  sequence,
  idempotency,
  retiredAttempt,
  captures,
  retiredReplyResult,
  replyCaptures,
  noPostAbortChunks,
  deliveredContextInvariant,
  I11,
  promised_closed_once,
  researchEvidence,
  retiredResearch,
];

const itemAuthority: Invariant = (before, event, after) => {
  const problems: string[] = [];
  for (const item of Object.values(after.domain.items)) {
    const previous = before.domain.items[item.id];
    if (item.status === 'stated' && previous?.status !== 'stated') {
      const inputs: QuoteInput[] = after.domain.inputs.filter(input => (input.origin ?? 'user') === 'user')
        .map(input => ({
        id: input.id,
        text: input.text,
        origin: input.origin ?? 'user',
        modality: input.modality ?? 'text',
      }));
      inputs.push(...deliveredQuoteInputs(after.domain));
      const result = validateSpans({
        text: item.text,
        status: 'stated',
        quoteSpans: item.provenance.quoteSpans,
      }, inputs, after.config);
      const userSpan = item.provenance.quoteSpans.some(span => inputs.some(input =>
        input.id === span.inputId && input.origin === 'user'));
      if (!result.allowed || result.status !== 'stated' || !userSpan) {
        problems.push('I8 stated without valid user wording');
      }
    }
    if (item.status === 'confirmed' && previous?.status !== 'confirmed') {
      const valid = event.type === 'item.action' && event.payload.action === 'confirm'
        && event.payload.itemId === item.id && previous?.contentVersion === event.payload.expectedVersion;
      if (!valid) problems.push('I8 confirmed without UI confirm');
    }
  }
  return problems;
};

const itemVersion: Invariant = (before, event, after) => {
  if (event.type !== 'item.action' || event.payload.action === 'delete') return [];
  const previous = before.domain.items[event.payload.itemId];
  if (!previous || previous.contentVersion === event.payload.expectedVersion) return [];
  const unchangedItems = isDeepStrictEqual(before.domain.items, after.domain.items);
  return unchangedItems && before.domain.projectRev === after.domain.projectRev
    ? []
    : ['I16 stale action changed project'];
};
invariantRegistry.push(itemAuthority, itemVersion);

// T06 hook: the contribution arbiter must call this at floor grant (I14).
export function uninterpretedFloorViolation(state: State, contributionGranted: boolean): string[] {
  return hasUninterpretedInput(state) && contributionGranted ? ['I14 contribution while input uninterpreted'] : [];
}

const uninterpretedPredicate: Invariant = (_before, _event, after) => {
  const expected = after.domain.inputs.some(input =>
    (input.origin ?? 'user') === 'user' && input.status !== 'interpreted');
  return hasUninterpretedInput(after) === expected ? [] : ['I14 uninterpreted predicate mismatch'];
};
invariantRegistry.push(uninterpretedPredicate);
