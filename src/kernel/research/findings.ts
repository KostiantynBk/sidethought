import type { Finding, KernelEvent } from '../../contract/index.js';
import type { Context, State } from '../state.js';
import { dependencyState } from './policy.js';
import { verifiedSupport } from './support.js';
import type { ResearchJob } from './types.js';

type Completed = Extract<KernelEvent, { type: 'job.completed' }>;

export function findingValidity(deps: Finding['deps'], domain: State['domain']): Finding['validity'] {
  const result = dependencyState(deps, domain.items);
  if (result.removed) return {
    state: 'stale',
    atRev: domain.projectRev,
    reason: result.removed,
  };
  if (result.edited.length) return {
    state: 'needs_recheck',
    editedItemIds: result.edited,
  };
  return { state: 'current' };
}

export function publishFinding(context: Context, finding: Finding): void {
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'finding.upserted',
      finding: structuredClone(finding),
    },
  });
}

export function completeFinding(context: Context, job: ResearchJob, event: Completed): void {
  const {
    investigatorOutput: output,
    retrievalEvidence: evidence,
  } = event.payload;
  const finding: Finding = {
    id: context.id(),
    jobId: job.id,
    questionKey: job.questionKey,
    retrievedAt: event.acceptedAt!,
    basisRev: job.basisRev,
    inputDeps: job.deps.map(dep => ({ ...dep })),
    deps: job.deps.map(dep => ({ ...dep })),
    rebases: [],
    validity: findingValidity(job.deps, context.domain),
    retrievalEvidence: structuredClone(evidence),
    verdict: evidence.completedSearchCalls > 0 ? output.verdict : 'not_researched',
    claims: output.claims.map(claim => ({
      text: claim.text,
      support: claim.support.map(support => ({
        ...support,
        quoteVerified: verifiedSupport(claim.text, support, evidence),
      })),
      corroboratedBy: [],
    })),
    caveats: [...output.caveats],
  };
  context.domain.findings[finding.id] = finding;
  publishFinding(context, finding);
  context.itemDecisions.push(evidence.completedSearchCalls > 0 ? 'research:finding' : 'research:not_researched');
}

export function refreshFindings(context: Context): void {
  for (const finding of Object.values(context.domain.findings)) {
    // Deletion is exclusively the purge hook (T08), never a stale-on-delete transition.
    if (finding.deps.some(dep => !context.domain.items[dep.itemId])) continue;
    if (finding.validity.state === 'stale' || finding.validity.state === 'withdrawn') continue;
    const validity = findingValidity(finding.deps, context.domain);
    if (JSON.stringify(validity) === JSON.stringify(finding.validity)) continue;
    finding.validity = validity;
    publishFinding(context, finding);
    context.itemDecisions.push(`research:validity:${validity.state}`);
  }
}

export function verifiedFindingUrls(domain: State['domain']): string[] {
  return Object.values(domain.findings).filter(finding => finding.validity.state === 'current')
    .flatMap(finding => finding.claims.flatMap(claim => claim.support
      .filter(support => support.quoteVerified).map(support => support.url)));
}
