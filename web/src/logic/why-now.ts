import type { ContributionView, View } from './view.js';

type ResearchView = Pick<View, 'jobs' | 'findings'>;

function questionFor(findingId: string | undefined, jobId: string | undefined, view: ResearchView): string | undefined {
  const finding = view.findings.find(item => item.id === findingId);
  const question = view.jobs.find(job => job.jobId === (finding?.jobId ?? jobId))?.publicQuery.trim();
  if (!question) return undefined;
  return question.length > 80 ? `${question.slice(0, 79).trimEnd()}…` : question;
}

function withQuestion(label: string, question: string | undefined): string {
  return question ? `${label} — "${question}"` : label;
}

export function whyNow(contribution: ContributionView, view: ResearchView): string | undefined {
  if (contribution.payload === 'evidence') {
    return withQuestion('Why now: your check finished', questionFor(contribution.findingId, contribution.jobId, view));
  }
  if (contribution.payload === 'clarification') return 'Why now: the answer changes your plan';
  if (contribution.payload === 'closure') return 'Why now: closing a check it promised';
  if (contribution.payload === 'inference') {
    const reasons: string[] = [];
    if (contribution.findingIds?.length) {
      reasons.push(withQuestion('built on research it ran', questionFor(contribution.findingIds[0], undefined, view)));
    }
    const lesson = contribution.lessons?.[0];
    if (lesson) reasons.push(`a reviewed lesson from ${lesson.sourceProjectName}`);
    return `Why now: ${reasons.length ? reasons.join('; ') : 'a tension between items in your plan'}`;
  }
  return undefined;
}
