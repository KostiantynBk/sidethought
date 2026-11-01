import { isDeepStrictEqual } from 'node:util';
import type { Effect, KernelEvent } from '../contract/index.js';
import type { Decision, State } from '../kernel/index.js';
import { isOpenJob } from '../kernel/research/types.js';
import { verifiedSupport } from '../kernel/research/support.js';

type Invariant = (
  before: State,
  event: KernelEvent,
  after: State,
  effects: Effect[],
  decisions: Decision[],
) => string[];

export const I11: Invariant = (_before, _event, after, effects, decisions) => {
  const jobs = Object.values(after.domain.jobs);
  const failures: string[] = [];
  if (jobs.filter(job => job.state === 'running').length > after.config.jobsMaxConcurrent) {
    failures.push('I11 concurrency exceeded');
  }
  if (jobs.filter(job => job.state === 'queued').length > after.config.jobsMaxQueued) {
    failures.push('I11 queue exceeded');
  }
  if (after.domain.researchAdmitted > after.config.jobsMaxPerSession) failures.push('I11 session cap exceeded');
  const budget = after.domain.researchBudget;
  const admitted = decisions.some(decision => decision.reason === 'research:admitted');
  const dispatched = effects.some(effect => effect.type === 'job.dispatch');
  if ((admitted || dispatched) && budget.spentUsd + budget.reservedUsd > after.config.sessionSoftCapUsd + 1e-9) {
    failures.push('I11 admission or dispatch exceeded budget');
  }
  if ((admitted || dispatched) && budget.global) {
    const global = budget.global;
    const unreported = Math.max(0, budget.spentUsd - global.sessionSpentAtUpdate);
    if (global.spentTodayUsd + global.reservedUsd + unreported + budget.reservedUsd
      > after.config.developmentDailyCapUsd + 1e-9) failures.push('I11 global budget exceeded');
  }
  return failures;
};

export const promised_closed_once: Invariant = (before, _event, after, effects) => {
  const failures: string[] = [];
  let added = 0;
  for (const job of Object.values(after.domain.jobs)) {
    const terminal = !isOpenJob(job) && job.state !== 'proposed' && job.state !== 'awaiting_user';
    const pending = Object.values(after.domain.initiative.candidates).some(candidate => candidate.jobId === job.id
      && ['candidate', 'checking', 'delivering', 'interrupted'].includes(candidate.state));
    const expected = job.promised && terminal;
    if (job.closureCount > 1 || job.closureCount < 0 || (!expected && job.closureCount !== 0)
      || (expected && job.closureCount !== 1 && !pending)) failures.push(`promised_closed_once: ${job.id}`);
    added += job.closureCount - (before.domain.jobs[job.id]?.closureCount ?? 0);
  }
  const closures = effects.filter(effect => effect.type === 'client.send'
    && effect.message.type === 'transcript.appended'
    && /^(?:Finished checking:|Couldn't check |Can't check that now:)/u.test(effect.message.text));
  const acknowledged = effects.filter(effect => effect.type === 'client.send'
    && effect.message.type === 'contribution.upserted' && effect.message.state === 'delivered'
    && (() => {
      const candidate = after.domain.initiative.candidates[effect.message.candidateId];
      return candidate?.jobId && after.domain.jobs[candidate.jobId]?.promised
        && (before.domain.jobs[candidate.jobId]?.closureCount ?? 0) === 0;
    })());
  if (closures.length + acknowledged.length !== added) failures.push('promised_closed_once: closure effect count differs');
  return failures;
};

export const researchEvidence: Invariant = (_before, _event, after) => {
  const failures: string[] = [];
  for (const finding of Object.values(after.domain.findings)) {
    const job = after.domain.jobs[finding.jobId];
    if (!job || job.questionKey !== finding.questionKey || !isDeepStrictEqual(job.deps, finding.inputDeps)) {
      failures.push('I7 finding detached from original job');
    }
    if (!finding.retrievalEvidence.completedSearchCalls && finding.verdict !== 'not_researched') {
      failures.push('I12 researched without completed search');
    }
    for (const claim of finding.claims) {
      for (const support of claim.support) {
        if (support.quoteVerified && (!support.quote || !verifiedSupport(claim.text, {
          ...support,
          quote: support.quote,
        }, finding.retrievalEvidence))) failures.push('I12 unsupported verified claim');
      }
    }
  }
  return failures;
};

export const retiredResearch: Invariant = (before, _event, after, effects, decisions) => {
  if (decisions[0]?.reason !== 'late:retired_job') return [];
  return effects.length === 0 && isDeepStrictEqual(before.domain, after.domain)
    ? [] : ['I18 retired job result mutated state'];
};
