import type { KernelEvent } from '../../contract/index.js';
import type { Context } from '../state.js';
import { budgetAllows } from './budget.js';
import { completeFinding } from './findings.js';
import { cancelJob, clearJobDeadline, dispatchJob, finishJob } from './lifecycle.js';
import { dependencyState, queryPrivacyFailure, researchControlBlock } from './policy.js';
import { isOpenJob, type ResearchJob } from './types.js';

type JobEvent = Extract<KernelEvent, { type: `job.${string}` }>;

export const TRANSIENT_FAILURE_PREFIX = 'transient_';

function failResearch(
  context: Context,
  job: ResearchJob,
  event: Extract<JobEvent, { type: 'job.failed' }>,
): string {
  const deps = dependencyState(job.deps, context.domain.items);
  // The executor classifies errors. Never retry arbitrary provider prose or schema failures.
  if (event.payload.reason.startsWith(TRANSIENT_FAILURE_PREFIX) && job.attempt <= context.config.jobMaxRetries
    && !deps.edited.length && !queryPrivacyFailure(context, job.publicQuery)
    && !researchControlBlock(context.domain) && budgetAllows(context, context.config.jobEstimateUsd)) {
    clearJobDeadline(context, job);
    dispatchJob(context, job, event.acceptedAt!);
    return 'research:retry';
  }
  finishJob(context, job, 'failed', event.acceptedAt!, 'the research service failed');
  return 'research:failed';
}

export function researchEvent(context: Context, event: JobEvent): string {
  const job = Object.values(context.domain.jobs).find(value => value.id === event.payload.jobId);
  if (event.type === 'job.cancelRequested') {
    if (!job || !isOpenJob(job)) return 'late:retired_job';
    cancelJob(context, job, event.acceptedAt!, 'cancelled by the user');
    return 'research:cancelled';
  }
  if (!('callId' in event.payload)) return 'noop:unhandled';
  if (!job || job.state !== 'running' || job.callId !== event.payload.callId
    || job.researchEpoch !== context.domain.researchEpoch) return 'late:retired_job';
  if (job.deadlineAt !== undefined && event.acceptedAt! >= job.deadlineAt) {
    return timeoutJob(context, job.id, event.acceptedAt!);
  }
  const deps = dependencyState(job.deps, context.domain.items);
  if (deps.removed) {
    cancelJob(context, job, event.acceptedAt!, 'the research basis changed');
    return 'research:dependency_cancelled';
  }
  if (event.type === 'job.started') return 'research:started';
  if (event.type === 'job.completed') {
    completeFinding(context, job, event);
    finishJob(context, job, 'succeeded', event.acceptedAt!, '');
    return 'research:succeeded';
  }
  if (event.type === 'job.failed') return failResearch(context, job, event);
  if (event.type === 'job.timedOut') return timeoutJob(context, job.id, event.acceptedAt!);
  finishJob(context, job, 'cancelled', event.acceptedAt!, 'the check was cancelled');
  return 'research:cancelled';
}

function timeoutJob(context: Context, id: string, at: number): string {
  const job = context.domain.jobs[id]!;
  context.effects.push({
    type: 'job.abort',
    callId: job.callId!,
  });
  finishJob(context, job, 'timed_out', at, 'the check exceeded its time limit');
  return 'research:timed_out';
}

export function researchDeadline(context: Context, timerId: string, at: number): string {
  const job = Object.values(context.domain.jobs).find(value => value.deadlineTimerId === timerId
    && value.state === 'running');
  return job ? timeoutJob(context, job.id, at) : 'stale:timer';
}

export function recoverResearch(context: Context, at: number): void {
  for (const job of Object.values(context.domain.jobs)) {
    if (isOpenJob(job)) finishJob(context, job, 'interrupted', at, 'the session restarted');
  }
  context.domain.pendingRequests = [];
  // §8.4: no usage means unknown billing. Keep content-free call reservations after restart.
}
