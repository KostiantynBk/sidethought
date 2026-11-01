import type { State } from '../kernel/state.js';

// §9.2: JSON's researchState field is a data delimiter, never an instruction channel.
export function researchContext(state: State) {
  return {
    jobs: Object.values(state.domain.jobs).filter(job => job.state === 'running' || job.state === 'queued')
      .map(job => ({
        title: job.question,
        state: job.state,
      })),
    findings: Object.values(state.domain.findings).filter(finding => finding.validity.state === 'current')
      .map(finding => ({
        question: state.domain.jobs[finding.jobId]?.question ?? '',
        verdict: finding.verdict,
        claims: finding.claims.filter(claim => claim.support.some(support => support.quoteVerified))
          .map(claim => ({
            text: claim.text,
            urls: claim.support.filter(support => support.quoteVerified).map(support => support.url),
          })),
        validity: finding.validity.state,
      })),
  };
}
