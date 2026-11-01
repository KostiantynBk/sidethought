import type { Item } from '../contract/index.js';
import type { State } from '../kernel/state.js';
import type { CallEffect, RolePrompt } from './index.js';
import { candidatePayload } from '../kernel/contributions/payload.js';
import { recentTurns } from './recent.js';
import { researchContext } from './research.js';
import { OUTPUT_RULES } from './prompts/common.js';
import { DELIBERATOR_PROMPT } from './prompts/deliberator.js';
import { CHECKER_PROMPT } from './prompts/checker.js';

function snapshotItems(items: Item[]) {
  return items.map(item => ({
    id: item.id,
    contentVersion: item.contentVersion,
    kind: item.kind,
    status: item.status,
    text: item.text,
    private: item.private,
  }));
}

export function contributionContext(state: State, effect: CallEffect, items: Item[]): RolePrompt {
  if (effect.role === 'checker') return checkerContext(state, effect, items);
  const call = state.domain.initiative.deliberation;
  if (!call || call.callId !== effect.callId || call.requestId !== effect.requestId
    || call.basisRev !== effect.basisRev) throw new Error('context:owner_mismatch');
  return {
    instructions: `${DELIBERATOR_PROMPT}\n\n${OUTPUT_RULES}`,
    input: JSON.stringify({
      projectSnapshot: {
        revision: `r${effect.basisRev}`,
        items: snapshotItems(items),
        openQuestions: items.filter(item => item.kind === 'open_question').map(item => item.id),
        dismissedTopics: state.domain.initiative.dismissedTopics,
        deprioritizedTopics: state.domain.deprioritizedTopics,
      },
      researchState: researchContext(state),
      recentWindow: recentTurns(state.domain, state.config.recentWindowTurns),
      contributions: Object.values(state.domain.initiative.candidates)
        .filter(candidate => !['dropped', 'superseded'].includes(candidate.state))
        .map(candidate => ({
          title: candidate.topic,
          state: candidate.state,
          payload: candidate.payload,
        })),
      task: {
        role: 'deliberator',
        instruction: "What matters that hasn't been said?",
        causalDepth: call.causalDepth,
        triggeringInputIds: call.inputIds,
      },
    }, null, 2),
  };
}

function checkerContext(state: State, effect: CallEffect, items: Item[]): RolePrompt {
  const candidate = Object.values(state.domain.initiative.candidates).find(value => value.state === 'checking'
    && value.check?.callId === effect.callId && value.check.requestId === effect.requestId);
  if (!candidate?.check || candidate.check.basisRev !== effect.basisRev) throw new Error('context:owner_mismatch');
  return {
    instructions: `${CHECKER_PROMPT}\n\n${OUTPUT_RULES}`,
    input: JSON.stringify({
      candidate: candidatePayload(state.domain, candidate),
      projectSnapshot: {
        revision: `r${effect.basisRev}`,
        items: snapshotItems(items),
      },
      deliveredPrefix: candidate.deliveredPrefix ?? '',
      task: {
        role: 'checker',
        candidateId: candidate.id,
        contract: candidate.payload === 'evidence'
          ? 'Each claimsUsed ID needs its OWN verified quote and semantic support; preserve all qualifiers.'
          : candidate.payload === 'inference'
            ? 'Reason only from cited current items; no evidence claims or added numbers/names.'
            : 'Ask the supplied clarification without factual additions; claimsUsed must be empty.',
      },
    }, null, 2),
  };
}
