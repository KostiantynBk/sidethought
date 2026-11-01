import type { KernelEvent } from '../../contract/index.js';
import type { Context } from '../state.js';
import type { ResearchJob } from './types.js';

export function reservedResearchUsd(context: Pick<Context, 'config' | 'domain'>): number {
  const queued = Object.values(context.domain.jobs).filter(job => job.state === 'queued').length;
  return queued * context.config.jobEstimateUsd + Object.values(context.domain.researchBudget.calls)
    .reduce((sum, call) => sum + call.reservedUsd, 0);
}

export function budgetAllows(context: Context, additionalUsd: number): boolean {
  const budget = context.domain.researchBudget;
  const reserved = reservedResearchUsd(context);
  if (budget.spentUsd + reserved + additionalUsd > context.config.sessionSoftCapUsd) return false;
  if (!budget.global) return true;
  // Global aggregates have no per-call watermark. Count local reservations conservatively
  // even if already included globally; never reuse stale headroom for several admissions.
  const unreportedSpend = Math.max(0, budget.spentUsd - budget.global.sessionSpentAtUpdate);
  return budget.global.spentTodayUsd + budget.global.reservedUsd + unreportedSpend + reserved + additionalUsd
    <= context.config.developmentDailyCapUsd;
}

export function publishBudget(context: Context): void {
  const budget = context.domain.researchBudget;
  budget.reservedUsd = reservedResearchUsd(context);
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'budget.updated',
      spentUsd: budget.spentUsd,
      reservedUsd: budget.reservedUsd,
    },
  });
}

export function reserveAttempt(context: Context, job: ResearchJob): void {
  context.domain.researchBudget.calls[job.callId!] = {
    jobId: job.id,
    reservedUsd: context.config.jobEstimateUsd,
    costUsd: 0,
    queries: 0,
  };
  publishBudget(context);
}

export function recordUsage(context: Context, event: Extract<KernelEvent, { type: 'llm.usage' }>): string {
  const budget = context.domain.researchBudget;
  const usage = event.payload;
  const call = budget.calls[usage.callId] ?? {
    reservedUsd: 0,
    costUsd: 0,
    queries: 0,
  };
  call.costUsd += usage.costUsd;
  call.queries += usage.queries;
  call.reservedUsd = 0;
  budget.calls[usage.callId] = call;
  budget.spentUsd += usage.costUsd;
  budget.queries += usage.queries;
  const job = 'jobId' in call && call.jobId ? context.domain.jobs[call.jobId] : undefined;
  if (job) {
    job.costUsd += usage.costUsd;
    job.queriesCounted += usage.queries;
  }
  publishBudget(context);
  return 'research:usage';
}
