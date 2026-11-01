import type { Finding } from '../../src/contract/models.js';

export type ResearchJob = { jobId: string; publicQuery: string; state: string };

function safeLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export function FindingCard({ finding }: { finding: Finding }) {
  return <article>
    <h3>Verdict: {finding.verdict}</h3>
    {finding.verdict === 'not_researched' && <p>No completed web search; this is not researched evidence.</p>}
    {finding.validity.state === 'stale' && <p>Applies to earlier version r{finding.validity.atRev}</p>}
    {finding.validity.state === 'needs_recheck' && <p>Needs recheck</p>}
    <p>Retrieved: {new Date(finding.retrievedAt).toISOString()}</p>
    {finding.claims.map((claim, index) => <div key={index}>
      <p>{claim.text} — {claim.support.some(support => support.quoteVerified) ? 'Verified' : 'Citation only'}</p>
      {claim.support.map((support, supportIndex) => <div key={supportIndex}>
        <span>{support.quoteVerified ? 'Verified' : 'Citation only'}</span>
        {support.quote && <blockquote>{support.quote}</blockquote>}
        {safeLink(support.url) && <a href={safeLink(support.url)} rel="noopener noreferrer">
          {support.title ?? support.url}
        </a>}
        <span> {support.sourceKind} {support.published}</span>
      </div>)}
    </div>)}
    {finding.caveats.map((caveat, index) => <p key={index}>{caveat}</p>)}
  </article>;
}

export function ResearchPanel(props: {
  jobs: ResearchJob[];
  findings: Finding[];
  onCancel: (jobId: string) => void;
}) {
  return <section aria-label="Research">
    <h2>Research</h2>
    {props.jobs.map(job => <div key={job.jobId}>
      <p>{job.publicQuery} — {job.state}</p>
      {(job.state === 'queued' || job.state === 'running') &&
        <button onClick={() => props.onCancel(job.jobId)}>Cancel</button>}
    </div>)}
    {props.findings.map(finding => <FindingCard key={finding.id} finding={finding} />)}
  </section>;
}
