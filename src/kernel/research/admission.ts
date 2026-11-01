import type { Context, State } from '../state.js';
import { budgetAllows, publishBudget } from './budget.js';
import { cancelJob, dispatchJob, notice, publishJob } from './lifecycle.js';
import { dependencyState, queryPrivacyFailure, questionKey, researchControlBlock } from './policy.js';
import { isOpenJob, type ResearchJob } from './types.js';

type Request = State['domain']['pendingRequests'][number];

function refusal(context: Context, query: string): string | undefined {
  const privacy = queryPrivacyFailure(context, query);
  if (privacy) return privacy;
  const control = researchControlBlock(context.domain);
  if (control) return control;
  if (context.domain.researchAdmitted >= context.config.jobsMaxPerSession) return 'session_cap';
  const queued = Object.values(context.domain.jobs).filter(job => job.state === 'queued').length;
  if (queued >= context.config.jobsMaxQueued) return 'queue_cap';
  if (!budgetAllows(context, context.config.jobEstimateUsd)) return 'budget';
  return undefined;
}

const refusalText: Record<string, string> = {
  private_term: 'the public query contains private terms',
  query_length: 'the public query is empty or too long',
  session_cap: 'the session research limit has been reached',
  queue_cap: 'the research queue is full',
  budget: 'the research budget is unavailable',
};

function createJob(context: Context, request: Request): ResearchJob {
  return {
    id: context.id(),
    state: 'proposed',
    question: request.question,
    questionKey: questionKey(request.question, request.deps),
    publicQuery: request.publicQuery,
    whyItMatters: 'Explicit user request',
    origin: 'user_request',
    promised: true,
    causalDepth: 0,
    deps: request.deps.map(dep => ({ ...dep })),
    depItemIds: [...request.depItemIds],
    inputIds: [request.inputId],
    basisRev: context.domain.projectRev,
    researchEpoch: context.domain.researchEpoch,
    attempt: 0,
    cancelRequested: false,
    queriesCounted: 0,
    costUsd: 0,
    closureCount: 0,
  };
}

function duplicate(context: Context, request: Request, at: number): ResearchJob | undefined {
  const key = questionKey(request.question, request.deps);
  return Object.values(context.domain.jobs).find(job => job.questionKey === key
    && (isOpenJob(job) || (job.state === 'succeeded' && job.completedAt !== undefined
      && at - job.completedAt <= context.config.jobDedupeWindowMs
      && Object.values(context.domain.findings).some(finding => finding.jobId === job.id
        && finding.validity.state === 'current'))));
}

function admit(context: Context, request: Request, at: number): void {
  const existing = duplicate(context, request, at);
  // Dedupe attaches to already-public work without dispatching another query (§8.2).
  if (existing) {
    existing.promised = true;
    if (!existing.inputIds.includes(request.inputId)) existing.inputIds.push(request.inputId);
    context.itemDecisions.push('research:duplicate');
    return;
  }
  const job = createJob(context, request);
  context.domain.jobs[job.id] = job;
  publishJob(context, job);
  const reason = refusal(context, request.publicQuery);
  if (reason) {
    job.state = 'rejected';
    job.completedAt = at;
    job.closureCount = 1;
    publishJob(context, job);
    notice(context, `Can't check that now: ${refusalText[reason] ?? 'research is disabled'}`);
    context.itemDecisions.push(`research:refused:${reason}`);
    return;
  }
  job.state = 'queued';
  context.domain.researchAdmitted += 1;
  publishJob(context, job);
  publishBudget(context);
  context.itemDecisions.push('research:admitted');
}

export function dispatchWaiting(context: Context, at: number): void {
  for (const job of Object.values(context.domain.jobs)) {
    if (job.state !== 'queued') continue;
    const active = Object.values(context.domain.jobs).filter(value => value.state === 'running').length;
    if (active >= context.config.jobsMaxConcurrent) break;
    const deps = dependencyState(job.deps, context.domain.items);
    const reason = deps.removed ?? (deps.edited.length ? 'edited' : undefined)
      ?? queryPrivacyFailure(context, job.publicQuery) ?? researchControlBlock(context.domain)
      ?? (job.researchEpoch !== context.domain.researchEpoch ? 'epoch' : undefined)
      ?? (!budgetAllows(context, 0) ? 'budget' : undefined);
    if (reason) {
      cancelJob(context, job, at, refusalText[reason] ?? 'the research basis changed');
      context.itemDecisions.push(`research:dispatch_blocked:${reason}`);
    } else {
      dispatchJob(context, job, at);
      context.itemDecisions.push('research:dispatched');
    }
  }
}

export function admitPending(context: Context, at: number): void {
  const requests = context.domain.pendingRequests;
  context.domain.pendingRequests = [];
  for (const request of requests) {
    admit(context, request, at);
    // Fill workers before measuring the next request against the queued-only limit.
    dispatchWaiting(context, at);
  }
}
