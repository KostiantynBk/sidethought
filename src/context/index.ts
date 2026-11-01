import type { Effect, Item } from '../contract/index.js';
import type { Call, State } from '../kernel/state.js';
import { recentTurns } from './recent.js';
import { OUTPUT_RULES } from './prompts/common.js';
import { INTERPRETER_PROMPT } from './prompts/interpreter.js';
import { RESPONDER_PROMPT } from './prompts/responder.js';
import { contributionContext } from './contributions.js';
import { researchContext } from './research.js';

export type RolePrompt = {
  instructions: string;
  input: string;
  suppliedLessons?: Array<{
    lessonId: string;
    version: number;
    sourceProjectName: string;
    text: string;
  }>;
};
export type CallEffect = Extract<Effect, { type: 'llm.call' }>;

function capturedItems(state: State, effect: CallEffect): Item[] {
  const seen = new Set<string>();
  return effect.capturedInputs.map(dep => {
    const item = state.domain.items[dep.itemId];
    if (seen.has(dep.itemId) || !item || item.contentVersion !== dep.contentVersion) {
      throw new Error(`context:capture_mismatch:${dep.itemId}`);
    }
    seen.add(dep.itemId);
    return item;
  });
}

function owner(state: State, effect: CallEffect): Pick<Call, 'callId' | 'requestId' | 'basisRev' | 'inputIds'> {
  const call = effect.role === 'interpreter' ? state.domain.call : state.domain.reply;
  if (!call || call.callId !== effect.callId || call.requestId !== effect.requestId
    || call.basisRev !== effect.basisRev) throw new Error('context:owner_mismatch');
  return call;
}

function task(state: State, effect: CallEffect) {
  const call = owner(state, effect);
  const overrides = effect.role === 'responder' ? state.domain.reply!.overridesSnapshotInputIds : [];
  const inputIds = [...new Set([...call.inputIds, ...overrides])];
  const inputs = inputIds.map(id => {
    const input = state.domain.inputs.find(candidate => candidate.id === id);
    if (!input || (input.origin ?? 'user') !== 'user') throw new Error('context:input_mismatch');
    return {
      id,
      text: input.text,
      ...(overrides.includes(id) ? { note: 'not yet in project state; it overrides the snapshot' } : {}),
    };
  });
  const clarification = effect.role === 'responder' ? state.domain.clarifications.findLast(entry =>
    entry.inputIds.some(id => inputIds.includes(id)))?.clarification : undefined;
  return {
    role: effect.role,
    requestId: effect.requestId,
    callId: effect.callId,
    inputs,
    ...(clarification ? { clarification } : {}),
  };
}

// §9.2 / A2: consume the dispatch capture, never substitute current items or raw state.
export function assembleContext(state: State, effect: CallEffect): RolePrompt {
  if (effect.role === 'deliberator' || effect.role === 'checker') {
    return contributionContext(state, effect, capturedItems(state, effect));
  }
  if (effect.role !== 'interpreter' && effect.role !== 'responder') throw new Error('context:unsupported_role');
  const items = capturedItems(state, effect).map(item => ({
    id: item.id,
    contentVersion: item.contentVersion,
    kind: item.kind,
    status: item.status,
    text: item.text,
    private: item.private,
  }));
  return {
    instructions: `${effect.role === 'interpreter' ? INTERPRETER_PROMPT : RESPONDER_PROMPT}\n\n${OUTPUT_RULES}`,
    input: JSON.stringify({
      projectSnapshot: {
        revision: `r${effect.basisRev}`,
        items,
        openQuestions: items.filter(item => item.kind === 'open_question').map(item => item.id),
        deprioritizedTopics: state.domain.deprioritizedTopics,
      },
      researchState: researchContext(state),
      recentWindow: effect.role === 'interpreter'
        ? state.domain.call!.quoteWitness.recent
        : recentTurns(state.domain, state.config.recentWindowTurns),
      task: task(state, effect),
    }, null, 2),
  };
}
