import { kernelId, type KernelEvent, type Effect } from '../contract/index.js';
import type { Context, State, Timer, Result } from './state.js';
import { connectClient, recoverDomain } from './recovery.js';
import { itemAction } from './items/index.js';
import { interpret, startWaiting } from './interpretation-lifecycle.js';
import { clearReplyWait, replyEvent, replyTimer } from './reply.js';
import { interruptReply } from './reply-abort.js';
import { clearComposer } from './composer.js';
import { replyDeadline } from './reply-failure.js';
import { deliveryProgress } from './delivery-progress.js';
import {
  advanceResearch, researchEvent, researchDeadline, recoverResearch, recordUsage, publishBudget,
} from './research/index.js';

import {
  beforeContributionEvent, contributionEvent, contributionTimer, advanceContributions, recoverContributions,
} from './contributions/index.js';

export { initialState } from './state.js';
export type { Call, Context, Decision, State, Timer } from './state.js';

export function hasUninterpretedInput(state: State): boolean {
  return state.domain.inputs.some(input => (input.origin ?? 'user') === 'user' && input.status !== 'interpreted');
}

export function clearWait(context: Context): void {
  context.domain.userWait = false;
  for (const timer of context.domain.timers.filter(item => item.purpose === 'userWait')) {
    context.effects.push({
      type: 'timer.clear',
      timerId: timer.timerId,
    });
  }
  context.domain.timers = context.domain.timers.filter(item => item.purpose !== 'userWait');
}

function retryInputs(context: Context, inputIds: string[]): void {
  for (const id of inputIds) {
    const input = context.domain.inputs.find(item => item.id === id);
    if (!input) {
      context.itemDecisions.push('retry:unknown_input');
    } else if (input.status !== 'needs_retry') {
      context.itemDecisions.push('retry:not_needed');
    } else {
      input.status = 'waiting';
      input.conflicts = 0;
    }
  }
  if (!context.domain.call) startWaiting(context);
}

function commitInput(context: Context, event: Extract<KernelEvent, { type: 'input.committed' }>, state: State): void {
  const { domain, effects } = context;
  // AD-7: abort and stop effects must precede even the next Interpreter dispatch.
  interruptReply(context, event.payload.renderedUpTo);
  clearWait(context);
  domain.composerActive = false;
  clearReplyWait(context);
  domain.floorEpoch += 1;
  domain.inputs.push({
    id: context.id(),
    text: event.payload.text,
    status: 'waiting',
    floorEpoch: domain.floorEpoch,
    ...(event.payload.modality === 'voice' ? { modality: 'voice' as const } : {}),
  });
  domain.replyPending = true;
  for (const timer of domain.timers.filter(item => item.purpose === 'replyDebounce')) {
    effects.push({
      type: 'timer.clear',
      timerId: timer.timerId,
    });
  }
  domain.timers = domain.timers.filter(timer => timer.purpose !== 'replyDebounce');
  const delay = event.payload.modality === 'voice' ? state.config.voiceGraceMs : state.config.replyDebounceMs;
  const timer: Timer = {
    timerId: context.id(),
    purpose: 'replyDebounce',
    dueAt: event.acceptedAt! + delay,
  };
  domain.timers.push(timer);
  effects.push({
    type: 'timer.set',
    ...timer,
  });
  if (!domain.call) startWaiting(context);
}


function fireTimer(
  context: Context,
  state: State,
  event: Extract<KernelEvent, { type: 'timer.fired' }>,
): string {
  const timer = context.domain.timers.find(item => item.timerId === event.payload.timerId);
  if (!timer) return 'stale:timer';
  context.domain.timers = context.domain.timers.filter(item => item.timerId !== timer.timerId);
  if (timer.purpose !== event.payload.purpose) return 'stale:timer';
  if (timer.purpose === 'userWait' && !context.domain.userWait) return 'stale:timer';
  if (timer.purpose === 'answerWait' && !context.domain.awaitingUserAnswer) return 'stale:timer';
  const contribution = contributionTimer(context, timer, event.acceptedAt!);
  if (contribution) return contribution;
  if (timer.purpose === 'answerWait') context.domain.awaitingUserAnswer = false;
  if (timer.purpose === 'jobDeadline') return researchDeadline(context, timer.timerId, event.acceptedAt!);
  if (timer.purpose === 'userWait') context.domain.userWait = false;
  if (timer.purpose === 'replyDebounce' || timer.purpose === 'interpreterSoftWait') {
    return replyTimer(context, timer.purpose, event.acceptedAt!, state.config);
  }
  if (['firstTokenTimeout', 'streamStall', 'callDeadline'].includes(timer.purpose)) {
    return replyDeadline(context, timer.purpose as 'firstTokenTimeout' | 'streamStall' | 'callDeadline',
      event.acceptedAt!, state.config);
  }
  return 'timer:fired';
}

function applyEvent(context: Context, state: State, event: KernelEvent): string {
  beforeContributionEvent(context, event);
  const contribution = contributionEvent(context, event);
  if (contribution) return contribution;
  switch (event.type) {
    case 'job.started':
    case 'job.completed':
    case 'job.failed':
    case 'job.timedOut':
    case 'job.cancelled':
    case 'job.cancelRequested':
      return researchEvent(context, event);
    case 'llm.usage':
      return recordUsage(context, event);
    case 'budget.global':
      context.domain.researchBudget.global = {
        ...event.payload,
        sessionSpentAtUpdate: context.domain.researchBudget.spentUsd,
      };
      publishBudget(context);
      return 'research:global_budget';
    case 'session.recovered':
      recoverContributions(context);
      recoverResearch(context, event.acceptedAt!);
      return recoverDomain(context);
    case 'client.connected':
      return connectClient(context, state, event.acceptedAt!, event.payload.modality);
    case 'client.disconnected':
      context.domain.clientConnected = false;
      clearComposer(context, event.acceptedAt!, state.config);
      return 'client:disconnected';
    case 'input.retry':
      retryInputs(context, event.payload.inputIds);
      return 'input:retry';
    case 'input.activity':
      if (event.payload.channel === 'composer') {
        if (!event.payload.active) {
          clearComposer(context, event.acceptedAt!, state.config);
          return 'input:activity';
        }
        context.domain.composerActive = true;
      }
      if (!event.payload.active) return 'noop:unhandled';
      clearWait(context);
      context.domain.floorEpoch += 1;
      return 'input:activity';
    case 'input.committed':
      commitInput(context, event, state);
      return 'input:committed';
    case 'interpretation.ready':
    case 'interpretation.failed':
      return interpret(context, event, state.config);
    case 'delivery.progress':
      return deliveryProgress(context, event);
    case 'reply.chunk':
    case 'reply.done':
    case 'reply.failed':
      return replyEvent(context, event, state.config);
    case 'item.action': {
      const result = itemAction(context.domain, event.payload);
      context.domain.items = result.state.items;
      context.domain.projectRev = result.state.projectRev;
      return result.decisions[0] ?? 'noop:unhandled';
    }
    case 'timer.fired':
      return fireTimer(context, state, event);
    default:
      return 'noop:unhandled';
  }
}

function applyAcceptedEvent(
  state: State,
  next: State,
  event: KernelEvent,
  effects: Effect[],
  itemDecisions: string[],
): string {
  const seq = next.meta.seq;
  let n = 0;
  const context: Context = {
    config: state.config,
    domain: {
      ...state.domain,
      inputs: state.domain.inputs.map(input => ({ ...input })),
      timers: state.domain.timers.map(timer => ({ ...timer })),
      pendingRequests: [...state.domain.pendingRequests],
      clarifications: [...state.domain.clarifications],
      reply: state.domain.reply ? structuredClone(state.domain.reply) : null,
      deliveries: structuredClone(state.domain.deliveries),
      jobs: structuredClone(state.domain.jobs),
      findings: structuredClone(state.domain.findings),
      researchBudget: structuredClone(state.domain.researchBudget),
      initiative: structuredClone(state.domain.initiative),
    },
    effects,
    itemDecisions,
    id: () => kernelId(state.sessionId, seq, ++n),
  };
  const reason = applyEvent(context, state, event);
  const expiredTimer = reason === 'stale:timer' && context.domain.timers.length !== state.domain.timers.length;
  const inert = ['late:retired_attempt', 'late:retired_reply', 'late:retired_job', 'stale:timer', 'noop:unhandled',
    'late:retired_deliberation', 'late:retired_check'];
  if (expiredTimer || !inert.includes(reason)) {
    if (!inert.includes(reason) && event.type !== 'session.recovered') {
      advanceResearch(context, event.acceptedAt!);
      advanceContributions(context, state, event);
    }
    next.domain = context.domain;
  }
  return reason;
}

export function reduce(state: State, event: KernelEvent): Result {
  if (event.sessionId !== state.sessionId || event.acceptedAt === undefined) {
    throw new Error('invalid session or missing acceptedAt');
  }
  const seq = state.meta.seq + 1;
  const dupEvent = state.meta.eventIds.includes(event.eventId);
  const dupClient = event.type === 'input.committed' && state.meta.clientMsgIds.includes(event.payload.clientMsgId);
  // The T04 journal UNIQUE(eventId) protects redeliveries older than this window (§6.3).
  const eventIds = dupEvent ? state.meta.eventIds : [...state.meta.eventIds, event.eventId].slice(-5000);
  let clientMsgIds = state.meta.clientMsgIds;
  if (event.type === 'input.committed' && !dupEvent && !dupClient) {
    clientMsgIds = [...clientMsgIds, event.payload.clientMsgId];
  }
  const next: State = {
    ...state,
    meta: {
      seq,
      eventIds,
      clientMsgIds,
    },
  };
  const effects: Effect[] = [];
  const itemDecisions: string[] = [];
  let reason: string;
  if (dupEvent || dupClient) {
    reason = dupEvent ? 'dup:eventId' : 'dup:clientMsgId';
  } else {
    reason = applyAcceptedEvent(state, next, event, effects, itemDecisions);
  }
  return {
    state: next,
    effects,
    decisions: [
      {
        seq,
        kind: 'kernel',
        reason,
      },
      ...itemDecisions.map(itemReason => ({
        seq,
        kind: 'item',
        reason: itemReason,
      })),
    ],
  };
}
