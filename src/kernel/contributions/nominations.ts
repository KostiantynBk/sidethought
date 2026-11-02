import type { Candidate, DeliberatorOutput, Dep, KernelEvent } from '../../contract/index.js';
import type { Context } from '../state.js';
import { refusal } from '../research/admission.js';
import { publishJob } from '../research/lifecycle.js';
import { dependencyState, questionKey } from '../research/policy.js';
import type { ResearchJob } from '../research/types.js';
import { nominationClass, withinScope } from './cuts.js';
import { addCandidate, researchClaims } from './candidates.js';
import { decide, topicBlocked, topicExists, topicKey, transition } from './common.js';
import type { RoleCall, Trigger } from './types.js';

type Nomination = DeliberatorOutput['nominations'][number];
type Investigation = Extract<Nomination, { kind: 'investigation' }>;
type Lesson = NonNullable<Candidate['source']['lessons']>[number];

function queue(context: Context, job: ResearchJob, at: number): void {
  const blocked = refusal(context, job.publicQuery);
  if (blocked) {
    job.state = 'rejected';
    job.completedAt = at;
    // No promise on autonomous work; explicit approvals get a fixed closure below.
    if (job.promised) job.state = 'failed';
    decide(context, `investigation:refused:${blocked}`);
  } else {
    job.state = 'queued';
    context.domain.researchAdmitted += 1;
    context.itemDecisions.push('research:admitted');
  }
  publishJob(context, job);
}

function investigate(
  context: Context,
  nomination: Investigation,
  call: RoleCall & Trigger,
  deps: Dep[],
  at: number,
  lessons: Lesson[],
) {
  if (!nomination.scores.answerable) {
    decide(context, 'investigation:not_answerable');
    return;
  }
  const key = questionKey(nomination.question, deps);
  const existing = Object.values(context.domain.jobs).find(job => job.questionKey === key
    && (['awaiting_user', 'queued', 'running'].includes(job.state)
      || (job.state === 'succeeded' && at - (job.completedAt ?? 0) <= context.config.jobDedupeWindowMs)));
  if (existing) {
    decide(context, 'investigation:duplicate');
    return;
  }
  const scores = nomination.scores;
  const ask = call.causalDepth >= 1 || scores.needsPrivateDetail || scores.consequence === 1
    || !withinScope(context) || lessons.length > 0;
  if (!ask && (scores.consequence < context.config.autoAdmitMinConsequenceScore
    || scores.uncertainty < context.config.autoAdmitMinUncertaintyScore)) {
    decide(context, 'investigation:low_value');
    return;
  }
  const job = nominatedJob(context, nomination, call, deps);
  context.domain.jobs[job.id] = job;
  if (!ask) {
    queue(context, job, at);
    return;
  }
  job.state = 'awaiting_user';
  publishJob(context, job);
  addCandidate(context, {
    class: 'card',
    payload: 'clarification',
    topic: nomination.topic,
    text: `Want me to check ${nomination.publicQuery}?`,
    deps,
    basisRev: call.basisRev,
    causalDepth: call.causalDepth,
    jobId: job.id,
  }, at);
  decide(context, 'investigation:awaiting_user');
}

function nominatedJob(context: Context, nomination: Investigation, call: RoleCall & Trigger, deps: Dep[]): ResearchJob {
  return {
    id: context.id(),
    state: 'proposed',
    question: nomination.question,
    questionKey: questionKey(nomination.question, deps),
    publicQuery: nomination.publicQuery,
    whyItMatters: nomination.topic,
    topic: nomination.topic,
    consequence: nomination.scores.consequence,
    origin: 'deliberator',
    promised: false,
    causalDepth: call.causalDepth,
    deps,
    depItemIds: deps.map(dep => dep.itemId),
    inputIds: [...call.inputIds],
    basisRev: call.basisRev,
    researchEpoch: context.domain.researchEpoch,
    attempt: 0,
    cancelRequested: false,
    queriesCounted: 0,
    costUsd: 0,
    closureCount: 0,
  };
}

export function acceptNominations(
  context: Context,
  nominations: Nomination[],
  call: RoleCall & Trigger,
  at: number,
  supplied: Lesson[] = [],
): void {
  for (const nomination of nominations.slice(0, context.config.maxDeliberatorNominations)) {
    if (nomination.kind === 'insight' && nomination.findingIds?.some(id => {
      const finding = context.domain.findings[id];
      return !finding || finding.validity.state !== 'current' || !researchClaims(finding).length;
    })) {
      decide(context, 'nomination:invalid_finding');
      continue;
    }
    const key = topicKey(nomination.topic);
    if (topicBlocked(context, key) || topicExists(context, key)) {
      decide(context, topicBlocked(context, key) ? 'nomination:dismissed' : 'nomination:duplicate');
      continue;
    }
    const deps = call.capturedInputs.filter(dep => nomination.depItemIds.includes(dep.itemId));
    if (dependencyState(deps, context.domain.items).removed) {
      decide(context, 'nomination:stale');
      continue;
    }
    if (nomination.kind === 'investigation') {
      investigate(context, nomination, call, deps, at, supplied);
      continue;
    }
    if (nomination.kind === 'clarification' && context.domain.initiative.askedTopics.includes(key)) {
      decide(context, 'nomination:already_asked');
      continue;
    }
    addCandidate(context, {
      class: nomination.kind === 'clarification' && nomination.scores.consequence < 3
        ? 'card' : nominationClass(nomination.scores.consequence),
      payload: nomination.kind === 'insight' ? 'inference' : 'clarification',
      topic: nomination.topic,
      text: nomination.kind === 'insight' ? nomination.insight : nomination.question,
      deps,
      basisRev: call.basisRev,
      causalDepth: call.causalDepth,
      ...(nomination.kind === 'insight' ? {
        source: {
          ...(nomination.lessonIds?.length ? {
            lessons: supplied.filter(lesson => nomination.lessonIds!.includes(lesson.lessonId)),
          } : {}),
          ...(nomination.findingIds?.length ? { findingIds: [...nomination.findingIds] } : {}),
        },
      } : {}),
    }, at);
  }
}

export function approval(
  context: Context,
  event: Extract<KernelEvent, { type: 'job.approve' | 'job.decline' }>,
): string {
  const job = context.domain.jobs[event.payload.jobId];
  if (!job || job.state !== 'awaiting_user') return 'late:retired_job';
  const candidate = Object.values(context.domain.initiative.candidates).find(value => value.jobId === job.id);
  if (candidate) transition(context, candidate, 'dropped', 'permission:resolved');
  if (event.type === 'job.decline') {
    job.state = 'rejected';
    publishJob(context, job);
    return 'research:declined';
  }
  job.promised = true;
  const validity = dependencyState(job.deps, context.domain.items);
  if (validity.removed || validity.edited.length) {
    job.state = 'failed';
    job.completedAt = event.acceptedAt!;
    publishJob(context, job);
    return 'research:approval_stale';
  }
  queue(context, job, event.acceptedAt!);
  return 'research:approved';
}
