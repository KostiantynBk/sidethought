import type { Context, Timer } from '../state.js';
import { questionKey } from '../research/policy.js';
import type { Contribution } from './types.js';

export function topicKey(topic: string): string {
  return questionKey(topic, []);
}

export function decide(context: Context, code: string, candidate?: Contribution): void {
  const reason = `contribution:${code}${candidate ? ` candidate=${candidate.id}` : ''}`;
  context.itemDecisions.push(reason);
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'inspector.decision',
      reason,
    },
  });
}

export function contributionView(candidate: Contribution) {
  return {
    candidateId: candidate.id,
    class: candidate.class,
    payload: candidate.payload,
    state: candidate.state,
    topic: candidate.topic,
    text: candidate.text,
    ...(candidate.source.lessons?.length ? { lessons: candidate.source.lessons } : {}),
    ...(candidate.source.findingId ? { findingId: candidate.source.findingId } : {}),
    ...(candidate.source.findingIds?.length ? { findingIds: candidate.source.findingIds } : {}),
    ...(candidate.jobId ? { jobId: candidate.jobId } : {}),
    ...(candidate.deliveryId ? { deliveryId: candidate.deliveryId } : {}),
  };
}

export function publish(context: Context, candidate: Contribution): void {
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'contribution.upserted',
      ...contributionView(candidate),
    },
  });
}

export function transition(
  context: Context,
  candidate: Contribution,
  state: Contribution['state'],
  code: string,
): void {
  candidate.state = state;
  publish(context, candidate);
  decide(context, code, candidate);
}

export function clearTimer(context: Context, timerId: string | undefined): void {
  if (!timerId) return;
  context.domain.timers = context.domain.timers.filter(timer => timer.timerId !== timerId);
  context.effects.push({
    type: 'timer.clear',
    timerId,
  });
}

export function arm(context: Context, purpose: Timer['purpose'], dueAt: number, ownerCallId?: string): string {
  const timer: Timer = {
    timerId: context.id(),
    purpose,
    dueAt,
    ...(ownerCallId ? { ownerCallId } : {}),
  };
  context.domain.timers.push(timer);
  context.effects.push({
    type: 'timer.set',
    timerId: timer.timerId,
    purpose,
    dueAt,
  });
  return timer.timerId;
}

export function wakeAt(context: Context, purpose: Timer['purpose'], dueAt: number): void {
  const existing = context.domain.timers.find(timer => timer.purpose === purpose);
  if (existing?.dueAt === dueAt) return;
  if (existing) clearTimer(context, existing.timerId);
  arm(context, purpose, dueAt);
}

export function capturedInputs(context: Context) {
  return Object.values(context.domain.items).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(item => ({
      itemId: item.id,
      contentVersion: item.contentVersion,
    }));
}

export function topicBlocked(context: Context, key: string): boolean {
  return context.domain.initiative.dismissedTopics.includes(key)
    || context.domain.deprioritizedTopics.some(topic => topicKey(topic) === key);
}

export function topicExists(context: Context, key: string, builtOn: string[] = []): boolean {
  // An idea built on finished research is not a repeat of that research's own evidence remark.
  return Object.values(context.domain.initiative.candidates).some(candidate => candidate.topicKey === key
    && !['dropped', 'superseded', 'interrupted'].includes(candidate.state)
    && !(candidate.payload === 'evidence' && builtOn.includes(candidate.source.findingId ?? '')));
}
