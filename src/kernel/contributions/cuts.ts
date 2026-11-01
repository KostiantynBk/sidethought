import type { Context } from '../state.js';
import type { Contribution } from './types.js';

// T12 proposed hackathon cuts, isolated from the core gates. Approval is still pending;
// the builder brief requests these conservative fallbacks after the core A/R slice.
// No Blocker exemption or correction candidate is inferred from a model result.
export function nominationClass(consequence: number): Contribution['class'] {
  return consequence >= 2 ? 'speak' : 'card';
}

export function interruptionOutcome(dismissed: boolean): Contribution['state'] {
  return dismissed ? 'dropped' : 'card_only';
}

// Full category matching and controls need an explicit architecture follow-up.
// In this slice all public technical questions use the default scope; [] switches auto-admission off.
export function withinScope(context: Context): boolean {
  return context.domain.initiative.scopeEnabled;
}

export function contributionControlBlock(_context: Context): string | undefined {
  return undefined;
}
