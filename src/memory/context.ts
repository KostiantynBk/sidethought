import { assembleContext, type CallEffect, type RolePrompt } from '../context/index.js';
import type { State } from '../kernel/index.js';
import type { ProjectMemoryStore } from './store.js';

export function assembleWithLessons(
  memory: ProjectMemoryStore,
  state: State,
  effect: CallEffect,
): RolePrompt {
  const prompt = assembleContext(state, effect);
  // Other projects' text must never enter the Interpreter's quote witness or authority path.
  if (effect.role !== 'responder') return prompt;
  const input = JSON.parse(prompt.input);
  const query = input.task.inputs.map((entry: { text: string }) => entry.text).join('\n');
  const lessons = memory.retrieve(state.sessionId, query);
  if (!lessons.length) return prompt;
  // Persist IDs/versions before the external request, without another copy of lesson content.
  memory.recordUse(effect.callId, state.sessionId, lessons);
  return {
    ...prompt,
    input: JSON.stringify({
      ...input,
      reusableLessons: lessons.map(lesson => ({
        id: lesson.id,
        version: lesson.version,
        sourceProjectId: lesson.sourceProjectId,
        sourceProjectName: lesson.sourceProjectName,
        sourceInputId: lesson.sourceInputId,
        sourceQuote: lesson.quote,
        sourceQuoteIsHistorical: true,
        lesson: lesson.text,
        status: 'user-confirmed reusable lesson; proposal only in this project',
      })),
    }, null, 2),
  };
}
