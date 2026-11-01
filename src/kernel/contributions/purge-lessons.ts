import type { State } from '../state.js';

// Memory changes run under the store transaction; no timers, IDs or I/O are introduced here.
export function dropCandidatesCitingLesson(state: Pick<State, 'domain'>, lessonId: string): void {
  const timers = new Set<string>();
  for (const candidate of Object.values(state.domain.initiative.candidates)) {
    if (!candidate.source.lessons?.some(lesson => lesson.lessonId === lessonId)) continue;
    if (candidate.check) timers.add(candidate.check.deadlineTimerId);
    delete candidate.check;
    candidate.state = 'dropped';
    candidate.text = '';
    candidate.topic = '[Removed experience]';
    candidate.topicKey = 'removed-experience';
    candidate.source = {};
    delete candidate.utterance;
    delete candidate.deliveredPrefix;
  }
  state.domain.timers = state.domain.timers.filter(timer => !timers.has(timer.timerId));
}
