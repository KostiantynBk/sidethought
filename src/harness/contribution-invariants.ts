import type { Effect, KernelEvent } from '../contract/index.js';
import type { State } from '../kernel/index.js';
import { dependencyState } from '../kernel/research/policy.js';
import { verifiedClaims } from '../kernel/contributions/candidates.js';

function started(after: State, effects: Effect[]) {
  return effects.flatMap(effect => {
    if (effect.type !== 'client.send' || effect.message.type !== 'contribution.upserted'
      || !['checking', 'delivering'].includes(effect.message.state)) return [];
    const candidate = after.domain.initiative.candidates[effect.message.candidateId];
    return candidate ? [candidate] : [];
  });
}

export function I1(_before: State, _event: KernelEvent, after: State, effects: Effect[]): string[] {
  for (const effect of effects) {
    if (effect.type !== 'client.send' || effect.message.type !== 'assistant.chunk') continue;
    const delivery = after.domain.deliveries[effect.message.deliveryId];
    if (!delivery?.candidateId) continue;
    const candidate = after.domain.initiative.candidates[delivery.candidateId]!;
    const validity = dependencyState(candidate.deps, after.domain.items);
    if (validity.removed || validity.edited.length) return ['I1 contribution chunk has invalid dependencies'];
  }
  return [];
}

export function I2(_before: State, _event: KernelEvent, after: State, effects: Effect[]): string[] {
  if (!started(after, effects).length) return [];
  if (after.domain.replyPending || after.domain.awaitingUserAnswer) return ['I2 reserved floor granted'];
  const active = Object.values(after.domain.deliveries).filter(delivery => delivery.state === 'delivering'
    && !delivery.settled && !delivery.finalAcknowledged);
  if (active.length > 1) return ['I2 assistant deliveries overlap'];
  return [];
}

export function I4(_before: State, _event: KernelEvent, after: State, effects: Effect[]): string[] {
  if (!started(after, effects).length) return [];
  if (after.domain.composerActive || after.domain.userWait
    || after.domain.timers.some(timer => timer.purpose === 'replyDebounce')) return ['I4 occupied floor granted'];
  if (!after.domain.clientConnected) return ['I4 disconnected floor granted'];
  return [];
}

export function I14(_before: State, _event: KernelEvent, after: State, effects: Effect[]): string[] {
  const uninterpreted = after.domain.inputs.some(input => (input.origin ?? 'user') === 'user'
    && input.status !== 'interpreted');
  return uninterpreted && started(after, effects).length ? ['I14 contribution while input uninterpreted'] : [];
}

export function I17(_before: State, _event: KernelEvent, after: State, effects: Effect[]): string[] {
  const delivering = started(after, effects).filter(candidate => candidate.state === 'delivering'
    && candidate.payload !== 'closure');
  return delivering.some(candidate => candidate.checkedAtRev !== after.domain.projectRev
    || candidate.checkedInputCount !== after.domain.inputs.length) ? ['I17 stale Checker result used'] : [];
}

export function I12(_before: State, _event: KernelEvent, after: State, effects: Effect[]): string[] {
  for (const effect of effects) {
    if (effect.type !== 'client.send' || effect.message.type !== 'assistant.chunk') continue;
    const delivery = after.domain.deliveries[effect.message.deliveryId];
    if (!delivery?.candidateId) continue;
    const candidate = after.domain.initiative.candidates[delivery.candidateId]!;
    if (candidate.payload === 'closure') continue;
    if (!candidate.checkCallId || !candidate.utterance) return ['I12 contribution without passing Checker'];
    if (candidate.payload !== 'evidence') {
      if (candidate.checkedClaims?.length) return ['I12 inference used evidence claims'];
      continue;
    }
    const finding = after.domain.findings[candidate.source.findingId!];
    const verified = finding ? verifiedClaims(finding) : [];
    if (!candidate.checkedClaims?.length || candidate.checkedClaims.some(id => !verified.some(claim => claim.id === id))) {
      return ['I12 spoken evidence without own verified quote and Checker support'];
    }
  }
  return [];
}
