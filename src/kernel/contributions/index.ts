import type { KernelEvent } from '../../contract/index.js';
import type { Context, State, Timer } from '../state.js';
import { dependencyState } from '../research/policy.js';
import { addFindings, ensureClosures } from './candidates.js';
import { interruptionOutcome } from './cuts.js';
import { arbitrate } from './arbiter.js';
import { checkDeadline, checkEvent } from './checking.js';
import { clearTimer, contributionView, decide, topicKey, transition } from './common.js';
import { contributionProgress, currentCheck, interruptContributions, stopContribution } from './delivery.js';
import { approval } from './nominations.js';
import { deliberationDeadline, finishDeliberation, scheduleDeliberation, startDeliberation } from './scheduling.js';

export function projectContributions(state: State) {
  return Object.values(state.domain.initiative.candidates)
    .filter(candidate => candidate.state !== 'dropped')
    .map(contributionView);
}

export function contributionEvent(context: Context, event: KernelEvent): string | undefined {
  if (event.type === 'deliberation.ready' || event.type === 'deliberation.failed') {
    return finishDeliberation(context, event);
  }
  if (event.type === 'check.ready' || event.type === 'check.failed') return checkEvent(context, event);
  if (event.type === 'job.approve' || event.type === 'job.decline') return approval(context, event);
  if (event.type === 'scope.set') {
    context.domain.initiative.scopeEnabled = event.payload.categories.length > 0;
    return 'contribution:scope';
  }
  if (event.type === 'finding.dismissed') {
    const finding = context.domain.findings[event.payload.findingId];
    const job = finding ? context.domain.jobs[finding.jobId] : undefined;
    if (!job) return 'noop:unhandled';
    const key = topicKey(job.topic ?? job.question);
    context.domain.initiative.dismissedTopics.push(key);
    return 'contribution:dismissed';
  }
  return undefined;
}

export function beforeContributionEvent(context: Context, event: KernelEvent): void {
  if (event.type === 'input.committed' || (event.type === 'input.activity' && event.payload.active)) {
    const rendered = event.type === 'input.committed' ? event.payload.renderedUpTo : undefined;
    interruptContributions(context, 'interrupted', rendered);
    context.domain.lastFloorActivity = event.acceptedAt!;
  }
  if (event.type === 'input.committed') {
    context.domain.awaitingUserAnswer = false;
    for (const timer of context.domain.timers.filter(value => value.purpose === 'answerWait')) {
      clearTimer(context, timer.timerId);
    }
  }
  if (event.type === 'client.disconnected') interruptContributions(context, 'disconnected');
}

export function contributionTimer(context: Context, timer: Timer, at: number): string | undefined {
  if (timer.purpose === 'deliberationDebounce') {
    startDeliberation(context, at);
    return 'deliberator:debounce';
  }
  if (timer.purpose === 'callDeadline' && deliberationDeadline(context, timer.timerId, at)) {
    return 'deliberator:timeout';
  }
  if (timer.purpose === 'checkTimeout' && checkDeadline(context, timer.timerId)) return 'check:timeout';
  if (timer.purpose === 'candidateExpiry') {
    for (const candidate of Object.values(context.domain.initiative.candidates)) {
      if (candidate.payload !== 'closure' && candidate.state === 'candidate' && at >= candidate.expiresAt!) {
        transition(context, candidate, 'card_only', 'freshness:expired');
      }
    }
    return 'contribution:expiry';
  }
  return undefined;
}

function triggers(context: Context, before: State, event: KernelEvent): void {
  if (context.domain.projectRev !== before.domain.projectRev
    && (event.type === 'interpretation.ready' || event.type === 'item.action')) {
    const inputIds = event.type === 'interpretation.ready' ? before.domain.call?.inputIds ?? []
      : [context.domain.inputs.at(-1)?.id ?? `action:${event.eventId}`];
    scheduleDeliberation(context, { inputIds, causalDepth: 0 }, event.acceptedAt!);
  }
  for (const job of Object.values(context.domain.jobs)) {
    if (job.state !== 'succeeded' || job.causalDepth !== 0 || job.followupScheduled) continue;
    job.followupScheduled = true;
    scheduleDeliberation(context, { inputIds: job.inputIds, causalDepth: 1 }, event.acceptedAt!);
  }
}

function refresh(context: Context): void {
  const pendingInput = context.domain.inputs.some(input => input.status !== 'interpreted');
  const failedInput = context.domain.inputs.some(input => input.status === 'needs_retry');
  for (const candidate of Object.values(context.domain.initiative.candidates)) {
    if (candidate.state === 'delivering' && (!currentCheck(context, candidate)
      || dependencyState(candidate.deps, context.domain.items).removed)) {
      stopContribution(context, candidate, 'basis_changed');
    }
    if (failedInput && ['candidate', 'checking'].includes(candidate.state) && candidate.payload !== 'closure') {
      if (candidate.check) {
        context.effects.push({ type: 'llm.abort', callId: candidate.check.callId });
        clearTimer(context, candidate.check.deadlineTimerId);
        delete candidate.check;
      }
      transition(context, candidate, 'card_only', 'interpretation_failed');
    }
    if (candidate.state !== 'interrupted' || (pendingInput && !failedInput) || context.domain.composerActive) continue;
    const dismissed = context.domain.inputs.at(-1)?.kind === 'dismissal';
    if (dismissed) context.domain.initiative.dismissedTopics.push(candidate.topicKey);
    const reason = dismissed ? 'interruption:dismissed' : 'interruption:card';
    transition(context, candidate, interruptionOutcome(dismissed), reason);
  }
}

export function advanceContributions(context: Context, before: State, event: KernelEvent): void {
  triggers(context, before, event);
  if (['reply.done', 'reply.failed', 'delivery.progress'].includes(event.type)) {
    context.domain.lastFloorActivity = event.acceptedAt!;
  }
  if (event.type === 'delivery.progress') contributionProgress(context, event);
  refresh(context);
  addFindings(context, event.acceptedAt!);
  ensureClosures(context, event.acceptedAt!);
  arbitrate(context, event.acceptedAt!);
  // A failed Checker / novelty gate may just have demoted the only closure-bearing evidence.
  ensureClosures(context, event.acceptedAt!);
}

export function recoverContributions(context: Context): void {
  const initiative = context.domain.initiative;
  initiative.deliberation = null;
  initiative.trigger = null;
  for (const candidate of Object.values(initiative.candidates)) {
    delete candidate.check;
    if (candidate.state === 'delivering') stopContribution(context, candidate, 'recovered');
    if (candidate.payload === 'closure' && candidate.state === 'candidate') continue;
    if (['candidate', 'checking', 'interrupted'].includes(candidate.state)) {
      transition(context, candidate, 'card_only', 'recovered');
    }
  }
}
