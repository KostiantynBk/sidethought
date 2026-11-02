import type { Candidate, Dep, Finding } from '../../contract/index.js';
import type { Context } from '../state.js';
import { consistentClaim } from '../research/support.js';
import { decide, publish, topicKey, transition } from './common.js';
import type { Contribution } from './types.js';

export type CandidateDraft = {
  class: Contribution['class'];
  payload: Contribution['payload'];
  topic: string;
  text: string;
  deps: Dep[];
  basisRev: number;
  causalDepth: number;
  jobId?: string;
  source?: Candidate['source'];
};

export function addCandidate(context: Context, draft: CandidateDraft, at: number): Contribution {
  const candidate: Contribution = {
    ...draft,
    id: context.id(),
    state: 'candidate',
    source: draft.source ?? {},
    inputDeps: structuredClone(draft.deps),
    deps: structuredClone(draft.deps),
    rebases: [],
    topicKey: topicKey(draft.topic),
    promised: draft.jobId ? context.domain.jobs[draft.jobId]?.promised ?? false : false,
    interruptions: 0,
    createdAt: at,
    expiresAt: at + context.config.candidateExpiryMs,
    rechecks: 0,
  };
  context.domain.initiative.candidates[candidate.id] = candidate;
  publish(context, candidate);
  decide(context, 'added', candidate);
  if (candidate.class === 'card') transition(context, candidate, 'card_only', 'class:card');
  return candidate;
}

export function verifiedClaims(finding: Finding) {
  if (finding.verdict === 'not_researched' || finding.verdict === 'inconclusive') return [];
  return finding.claims.flatMap((claim, index) => {
    const support = claim.support.filter(source => source.quoteVerified && source.quote
      && consistentClaim(claim.text, source.quote));
    return support.length ? [{
      id: `${finding.id}:claim:${index}`,
      text: claim.text,
      support,
    }] : [];
  });
}

export function addFindings(context: Context, at: number): void {
  for (const finding of Object.values(context.domain.findings)) {
    const candidates = Object.values(context.domain.initiative.candidates);
    if (candidates.some(candidate => candidate.source.findingId === finding.id)) continue;
    const job = context.domain.jobs[finding.jobId];
    if (!job) continue;
    const answer = finding.deps.some(dep => context.domain.items[dep.itemId]?.kind === 'open_question');
    const relevant = job.promised || answer || (job.consequence ?? 0) >= 2;
    const speak = relevant && verifiedClaims(finding).length > 0
      && !['stale', 'withdrawn'].includes(finding.validity.state);
    addCandidate(context, {
      class: speak ? 'speak' : 'card',
      payload: 'evidence',
      topic: job.topic ?? job.question,
      text: '',
      source: { findingId: finding.id },
      deps: finding.deps,
      basisRev: finding.basisRev,
      causalDepth: job.causalDepth,
      jobId: job.id,
    }, at);
  }
}

export function ensureClosures(context: Context, at: number): void {
  for (const job of Object.values(context.domain.jobs)) {
    if (!job.promised || job.closureCount || !['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted']
      .includes(job.state)) continue;
    const candidates = Object.values(context.domain.initiative.candidates)
      .filter(candidate => candidate.jobId === job.id);
    const pending = candidates.some(candidate => ['candidate', 'checking', 'delivering', 'interrupted']
      .includes(candidate.state) && candidate.class === 'speak');
    if (pending || candidates.some(candidate => candidate.payload === 'closure')) continue;
    const card = Object.values(context.domain.findings).some(finding => finding.jobId === job.id);
    addCandidate(context, {
      class: 'speak',
      payload: 'closure',
      topic: `Closure: ${job.question}`,
      text: "I couldn't verify that within this check" + (card ? ' — what I found is on the card' : ''),
      deps: [],
      basisRev: context.domain.projectRev,
      causalDepth: job.causalDepth,
      jobId: job.id,
    }, at);
  }
}
