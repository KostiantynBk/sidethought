import type { Context } from '../state.js';
import { publishBudget, reserveAttempt } from './budget.js';
import type { ResearchJob } from './types.js';

export function notice(context: Context, text: string): void {
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'transcript.appended',
      text,
    },
  });
}

export function projectJob(job: ResearchJob) {
  return {
    jobId: job.id,
    publicQuery: job.publicQuery,
    state: job.state,
  };
}

export function publishJob(context: Context, job: ResearchJob): void {
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'job.updated',
      ...projectJob(job),
    },
  });
}

function title(job: ResearchJob): string {
  return job.question.replace(/\s+/gu, ' ').slice(0, 100);
}

export function clearJobDeadline(context: Context, job: ResearchJob): void {
  if (!job.deadlineTimerId) return;
  context.domain.timers = context.domain.timers.filter(timer => timer.timerId !== job.deadlineTimerId);
  context.effects.push({
    type: 'timer.clear',
    timerId: job.deadlineTimerId,
  });
  delete job.deadlineTimerId;
}

export function finishJob(
  context: Context,
  job: ResearchJob,
  state: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted',
  at: number,
  reason: string,
): void {
  clearJobDeadline(context, job);
  job.state = state;
  job.completedAt = at;
  publishJob(context, job);
  if (job.promised && job.closureCount === 0) {
    job.closureCount = 1;
    notice(context, state === 'succeeded'
      ? `Finished checking: ${title(job)} — see the card`
      : `Couldn't check ${title(job)}: ${reason}`);
  }
  publishBudget(context);
}

export function cancelJob(context: Context, job: ResearchJob, at: number, reason: string): void {
  job.cancelRequested = true;
  if (job.callId) context.effects.push({
    type: 'job.abort',
    callId: job.callId,
  });
  finishJob(context, job, 'cancelled', at, reason);
}

export function dispatchJob(context: Context, job: ResearchJob, at: number): void {
  job.state = 'running';
  job.attempt += 1;
  job.callId = context.id();
  job.deadlineAt ??= at + context.config.jobDeadlineMs;
  job.deadlineTimerId = context.id();
  publishJob(context, job);
  reserveAttempt(context, job);
  if (job.attempt === 1) notice(context, `Checking: ${title(job)}`);
  context.effects.push({
    type: 'job.dispatch',
    jobId: job.id,
    callId: job.callId,
    capturedInputs: job.deps.map(dep => ({ ...dep })),
  });
  const timer = {
    timerId: job.deadlineTimerId,
    purpose: 'jobDeadline' as const,
    dueAt: job.deadlineAt,
  };
  context.domain.timers.push(timer);
  context.effects.push({
    type: 'timer.set',
    ...timer,
  });
}
