import type { Context, State } from '../state.js';
import { admitPending, dispatchWaiting } from './admission.js';
import { cancelJob } from './lifecycle.js';
import { dependencyState, queryPrivacyFailure, researchControlBlock } from './policy.js';
import { refreshFindings } from './findings.js';
import { isOpenJob } from './types.js';

export { researchEvent, researchDeadline, recoverResearch } from './events.js';
export { recordUsage, publishBudget } from './budget.js';

export function advanceResearch(context: Context, at: number): void {
  for (const job of Object.values(context.domain.jobs)) {
    if (!isOpenJob(job)) continue;
    const deps = dependencyState(job.deps, context.domain.items);
    if (deps.removed) {
      cancelJob(context, job, at, 'the research basis changed');
      context.itemDecisions.push(`research:dependency_cancelled:${deps.removed}`);
    }
  }
  refreshFindings(context);
  admitPending(context, at);
  dispatchWaiting(context, at);
}

// Binding seam: the executor receives no question, project text or finding content (§4.5).
export function jobForDispatch(state: State, jobId: string): { publicQuery: string } | undefined {
  const job = Object.values(state.domain.jobs).find(value => value.id === jobId);
  if (!job || job.state !== 'running' || job.researchEpoch !== state.domain.researchEpoch) return undefined;
  const deps = dependencyState(job.deps, state.domain.items);
  if (deps.removed || deps.edited.length || researchControlBlock(state.domain)
    || queryPrivacyFailure(state, job.publicQuery)) return undefined;
  return { publicQuery: job.publicQuery };
}

// Unwired T08 seam only. T08 owns aborts, content-free closures and journal/transcript redaction (B20).
export function purgeResearchDerivedFrom(state: State, itemId: string): State {
  const jobs = Object.fromEntries(Object.entries(state.domain.jobs)
    .filter(([, job]) => !job.deps.some(dep => dep.itemId === itemId)));
  const findings = Object.fromEntries(Object.entries(state.domain.findings)
    .filter(([, finding]) => !finding.inputDeps.some(dep => dep.itemId === itemId)
      && !finding.deps.some(dep => dep.itemId === itemId) && Boolean(jobs[finding.jobId])));
  return {
    ...state,
    domain: {
      ...state.domain,
      jobs,
      findings,
      pendingRequests: state.domain.pendingRequests.filter(request => !request.deps.some(dep => dep.itemId === itemId)),
    },
  };
}
