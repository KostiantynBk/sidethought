import type { State } from '../state.js';
import { reservedResearchUsd } from './budget.js';

// Lesson redaction clears extracted items atomically. Research based on them must not survive as current.
export function purgeOrphanResearch(state: Pick<State, 'config' | 'domain'>): string[] {
  const removedJobIds: string[] = [];
  const timerIds = new Set<string>();
  for (const job of Object.values(state.domain.jobs)) {
    if (!job.deps.some(dep => !state.domain.items[dep.itemId])) continue;
    removedJobIds.push(job.id);
    if (job.deadlineTimerId) timerIds.add(job.deadlineTimerId);
    delete state.domain.jobs[job.id];
  }
  for (const finding of Object.values(state.domain.findings)) {
    const missing = [...finding.deps, ...finding.inputDeps].some(dep => !state.domain.items[dep.itemId]);
    if (missing || !state.domain.jobs[finding.jobId]) delete state.domain.findings[finding.id];
  }
  state.domain.timers = state.domain.timers.filter(timer => !timerIds.has(timer.timerId));
  // Call reservations contain only IDs and numeric billing, and remain until usage arrives.
  state.domain.researchBudget.reservedUsd = reservedResearchUsd(state);
  return removedJobIds;
}

export function hasCurrentDependencies(
  state: Pick<State, 'domain'>,
  finding: State['domain']['findings'][string],
): boolean {
  if (finding.validity.state !== 'current' || !state.domain.jobs[finding.jobId]) return false;
  return [...finding.deps, ...finding.inputDeps].every(dep => Boolean(state.domain.items[dep.itemId]));
}
