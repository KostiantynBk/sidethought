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
        instruction: call.causalDepth >= 1
          ? 'Research you started has finished. Suggest one new concrete next step, not a recap or prior advice. '
            + 'Use a topic naming that step and exact researchState finding IDs. Keep the insight to two short '
            + 'sentences. Copy depItemIds only from projectSnapshot.items[].id, or use [] when no items exist.'
          : "What matters that hasn't been said? Copy depItemIds only from projectSnapshot.items[].id; "
            + 'use [] if no items exist. triggeringInputIds are not item IDs.',
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
          ? 'State one relevant verified claim using its own words, with all qualifiers. Each claimsUsed ID '
            + 'needs its OWN verified quote and semantic support; claimsUsed must not be empty. '
            + 'At most two short sentences; no new commentary or stronger claims.'
          : candidate.payload === 'inference'
            ? 'Check current applicability, then copy the supported idea in at most two short sentences. '
              + 'Use only candidate wording and its cited items, lessons and verified research. Attribute '
              + 'lessons, suggest rather than decide, and list research claim IDs actually stated. '
              + 'Add no NEW source/retrieval commentary or terminology; preserve material uncertainty '
              + 'and source-quality caveats already in candidate.text. Do not drop a caveat to shorten it.'
            : 'Ask the supplied clarification without factual additions; claimsUsed must be empty.',
      },
    }, null, 2),
  };
}
