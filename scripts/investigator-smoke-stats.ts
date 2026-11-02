import type { InvestigatorOutput, RetrievalEvidence } from '../src/contract/index.js';

// Completion evidence is authoritative; pagesFetched fires before structuring and excerpts.
export function completedEvidenceStats(evidence: RetrievalEvidence, output: InvestigatorOutput) {
  return {
    excerpts: evidence.results.filter(result => result.snippet?.trim()).length,
    completedSearchCalls: evidence.completedSearchCalls,
    claimCount: output.claims.length,
  };
}
