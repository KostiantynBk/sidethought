import type { KernelEvent } from '../contract/index.js';
import type { Config } from '../config/index.js';
import type { Call, Context, Timer } from './index.js';
import { clearWait } from './index.js';
import { applyInterpretation } from './interpretation.js';
import { resumeReplyWait } from './reply.js';
import { captureQuoteWitness } from '../context/quote-sources.js';

function dispatch(context: Context, draft: Omit<Call, 'quoteWitness'>): void {
  const call: Call = {
    ...draft,
    quoteWitness: captureQuoteWitness(context.domain, draft.inputIds, context.config.recentWindowTurns),
  };
  context.domain.call = call;
  context.effects.push({
    type: 'llm.call',
    role: 'interpreter',
    requestId: call.requestId,
    callId: call.callId,
    basisRev: call.basisRev,
    capturedInputs: call.capturedInputs.map(item => ({ ...item })),
  });
}

export function startWaiting(context: Context): void {
  const waiting = context.domain.inputs.filter(input => input.status === 'waiting');
  if (!waiting.length) return;
  for (const input of waiting) input.status = 'inflight';
  dispatch(context, {
    requestId: context.id(),
    callId: context.id(),
    attempt: 1,
    inputIds: waiting.map(input => input.id),
    basisRev: context.domain.projectRev,
    capturedInputs: Object.values(context.domain.items)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(item => ({
        itemId: item.id,
        contentVersion: item.contentVersion,
      })),
  });
}

function handleConflict(context: Context, call: Call): string {
  const batch = context.domain.inputs.filter(input => call.inputIds.includes(input.id));
  for (const input of batch) {
    input.conflicts = (input.conflicts ?? 0) + 1;
  }
  const twice = batch.some(input => input.conflicts! > 1);
  for (const input of batch) input.status = twice ? 'needs_retry' : 'waiting';
  context.domain.call = null;
  // A later batch may be waiting even when these inputs need an explicit retry (§4.4).
  startWaiting(context);
  return twice ? 'patch:conflict_needs_retry' : 'patch:conflict_reinterpret';
}

function applyWait(context: Context, call: Call, at: number, config: Config): void {
  const last = context.domain.inputs.at(-1);
  if (!last || last.kind !== 'wait' || !call.inputIds.includes(last.id)
    || last.floorEpoch !== context.domain.floorEpoch) return;
  clearWait(context);
  context.domain.userWait = true;
  // §8.1: a late wait classification does not take the reservation from a started Responder.
  if (context.domain.reply?.status !== 'streaming') context.domain.replyPending = false;
  const timer: Timer = {
    timerId: context.id(),
    purpose: 'userWait',
    dueAt: at + config.userWaitMs,
  };
  context.domain.timers.push(timer);
  context.effects.push({
    type: 'timer.set',
    ...timer,
  });
}

function finish(
  context: Context,
  event: Extract<KernelEvent, { type: 'interpretation.ready' | 'interpretation.failed' }>,
  call: Call,
  applied: boolean,
  config: Config,
): string {
  for (const input of context.domain.inputs.filter(item => call.inputIds.includes(item.id))) {
    input.status = applied ? 'interpreted' : 'needs_retry';
    if (event.type === 'interpretation.ready' && applied) {
      input.kind = event.payload.output.inputKinds.find(entry => entry.inputId === input.id)?.kind;
    }
  }
  if (applied) applyWait(context, call, event.acceptedAt!, config);
  context.domain.call = null;
  startWaiting(context);
  const replyDecision = resumeReplyWait(context, event.acceptedAt!, config);
  return replyDecision ?? (applied ? 'interpreter:ready' : 'interpreter:needs_retry');
}

export function interpret(
  context: Context,
  event: Extract<KernelEvent, { type: 'interpretation.ready' | 'interpretation.failed' }>,
  stateConfig: Config,
): string {
  const call = context.domain.call;
  if (!call || call.requestId !== event.payload.requestId || call.callId !== event.payload.callId) {
    return 'late:retired_attempt';
  }
  const result = event.type === 'interpretation.ready'
    ? applyInterpretation(context, event.payload.output, call, stateConfig)
    : 'invalid';
  if (result === 'invalid' && call.attempt === 1) {
    dispatch(context, {
      ...call,
      callId: context.id(),
      attempt: 2,
    });
    return 'interpreter:retry';
  }
  if (result === 'conflict') return handleConflict(context, call);
  return finish(context, event, call, result === 'applied', stateConfig);
}
