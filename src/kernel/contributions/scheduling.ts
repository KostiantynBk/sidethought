import type { KernelEvent } from '../../contract/index.js';
import type { Context } from '../state.js';
import { budgetAllows, publishBudget, reservedResearchUsd } from '../research/budget.js';
import { arm, capturedInputs, clearTimer, decide, wakeAt } from './common.js';
import { acceptNominations } from './nominations.js';
import type { Trigger } from './types.js';

type DeliberationEvent = Extract<KernelEvent, { type: 'deliberation.ready' | 'deliberation.failed' }>;

export function scheduleDeliberation(context: Context, trigger: Trigger, at: number): void {
  const initiative = context.domain.initiative;
  const previous = initiative.trigger;
  initiative.trigger = {
    inputIds: [...new Set([...(previous?.inputIds ?? []), ...trigger.inputIds])],
    causalDepth: Math.max(previous?.causalDepth ?? 0, trigger.causalDepth),
  };
  // A dirty in-flight call owns exactly one subsequent run; no parallel dispatch.
  if (initiative.deliberation) {
    decide(context, 'deliberator:dirty');
    return;
  }
  wakeAt(context, 'deliberationDebounce', at + context.config.deliberationDebounceMs);
  decide(context, 'deliberator:debounced');
}

function limit(context: Context, trigger: Trigger, at: number): string | undefined {
  const initiative = context.domain.initiative;
  initiative.runTimes = initiative.runTimes.filter(time => time > at - 60000);
  if (!trigger.inputIds.length) return 'no_user_cause';
  if (trigger.inputIds.some(id => (initiative.runsPerInput[id] ?? 0) >= context.config.maxDeliberatorRunsPerInput)) {
    return 'input_limit';
  }
  if (initiative.runTimes.length >= context.config.maxDeliberatorRunsPerMinute) return 'minute_limit';
  if (context.domain.researchBudget.spentUsd + reservedResearchUsd(context) >= context.config.sessionSoftCapUsd
    || !budgetAllows(context, context.config.deliberatorEstimateUsd)) return 'budget';
  return undefined;
}

export function startDeliberation(context: Context, at: number): void {
  const initiative = context.domain.initiative;
  const trigger = initiative.trigger;
  if (!trigger || initiative.deliberation) return;
  initiative.trigger = null;
  const blocked = limit(context, trigger, at);
  if (blocked) {
    decide(context, `deliberator:${blocked}`);
    return;
  }
  const callId = context.id();
  const deadlineAt = at + context.config.deliberatorTimeoutMs;
  const call = {
    ...trigger,
    requestId: context.id(),
    callId,
    basisRev: context.domain.projectRev,
    capturedInputs: capturedInputs(context),
    deadlineAt,
    deadlineTimerId: arm(context, 'callDeadline', deadlineAt, callId),
  };
  initiative.deliberation = call;
  initiative.runTimes.push(at);
  for (const id of trigger.inputIds) initiative.runsPerInput[id] = (initiative.runsPerInput[id] ?? 0) + 1;
  context.domain.researchBudget.calls[callId] = {
    reservedUsd: context.config.deliberatorEstimateUsd,
    costUsd: 0,
    queries: 0,
  };
  publishBudget(context);
  context.effects.push({
    type: 'llm.call',
    role: 'deliberator',
    requestId: call.requestId,
    callId,
    basisRev: call.basisRev,
    capturedInputs: call.capturedInputs,
  });
  decide(context, 'deliberator:started');
}

export function finishDeliberation(context: Context, event: DeliberationEvent): string {
  const call = context.domain.initiative.deliberation;
  if (!call || call.callId !== event.payload.callId || call.requestId !== event.payload.requestId) {
    return 'late:retired_deliberation';
  }
  clearTimer(context, call.deadlineTimerId);
  context.domain.initiative.deliberation = null;
  if (event.acceptedAt! >= call.deadlineAt) {
    decide(context, 'deliberator:deadline');
  } else if (event.type === 'deliberation.ready') {
    const captured = new Set(call.capturedInputs.map(dep => dep.itemId));
    const nominations = event.payload.output.nominations;
    if (nominations.some(nomination => nomination.depItemIds.some(id => !captured.has(id)))) {
      decide(context, 'deliberator:schema_failure');
    } else {
      acceptNominations(context, nominations, call, event.acceptedAt!);
    }
  }
  // Results never cause new reasoning by themselves; only a recorded dirty trigger can do so.
  startDeliberation(context, event.acceptedAt!);
  return event.type === 'deliberation.ready' ? 'deliberator:ready' : 'deliberator:failed';
}

export function deliberationDeadline(context: Context, timerId: string, at: number): boolean {
  const call = context.domain.initiative.deliberation;
  if (call?.deadlineTimerId !== timerId) return false;
  context.effects.push({
    type: 'llm.abort',
    callId: call.callId,
  });
  context.domain.initiative.deliberation = null;
  decide(context, 'deliberator:deadline');
  startDeliberation(context, at);
  return true;
}
