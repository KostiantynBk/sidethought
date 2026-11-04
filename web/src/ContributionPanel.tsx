import type { Finding } from '../../src/contract/models.js';
import type { ContributionView } from './logic/view.js';
import type { ResearchJob } from './ResearchPanel.js';
import { contributionLabel } from './contribution-label.js';
import { whyNow } from './logic/why-now.js';

export function ContributionPanel(props: {
  contributions: ContributionView[];
  jobs: ResearchJob[];
  findings?: Finding[];
  onApprove: (jobId: string) => void;
  onDecline: (jobId: string) => void;
}) {
  return <section aria-label="Contribution cards">
    <h2>Contribution cards</h2>
    {props.contributions.filter(item => {
      const job = props.jobs.find(candidate => candidate.jobId === item.jobId);
      return item.state === 'card_only' || item.state === 'delivered' || job?.state === 'awaiting_user';
    }).map(item => {
      const job = props.jobs.find(candidate => candidate.jobId === item.jobId);
      return <article id={`contribution-${item.candidateId}`} key={item.candidateId}>
        <h3>{item.topic}</h3>
        <p>{contributionLabel(item)}</p>
        <p className="why-now">{whyNow(item, { jobs: props.jobs, findings: props.findings ?? [] })}</p>
        {item.text && <p>{item.text}</p>}
        {item.lessons?.map(lesson => <p key={lesson.lessonId}>
          <strong>Experience — from your project {lesson.sourceProjectName}:</strong> {lesson.text}
        </p>)}
        {item.findingId && <a href={`#finding-${item.findingId}`}>View evidence card</a>}
        {item.jobId && job?.state === 'awaiting_user' && <>
          <p>Want me to check {job.publicQuery}?</p>
          <button type="button" onClick={() => props.onApprove(job.jobId)}>Check</button>
          <button type="button" onClick={() => props.onDecline(job.jobId)}>No</button>
        </>}
      </article>;
    })}
  </section>;
}
