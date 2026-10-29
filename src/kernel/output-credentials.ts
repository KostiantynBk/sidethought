import { CREDENTIAL_TERM, DEFAULT_CREDENTIAL_REQUEST_PATTERNS, REQUEST_VERB } from '../config/output-policy.js';
import type { Config } from '../config/index.js';

const term = new RegExp(`\\b${CREDENTIAL_TERM}\\b`, 'iu');
const requestStart = new RegExp(`^(?:please\\s+)?${REQUEST_VERB}\\b`, 'iu');
const questionVerb = new RegExp(`^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${REQUEST_VERB}\\b`, 'iu');
const caution = /\b(?:never|don't|do not|avoid|shouldn't|must not|no one|nobody)\b/iu;
const anyVerb = new RegExp(`\\b(?:${REQUEST_VERB}|will|would|can|could|is|are|was|were|has|have|should)\\b`, 'iu');
const newClause = new RegExp(
  `,?\\s+\\b(?:and|but)\\b\\s+(?=(?:please|never|don't|do|avoid|shouldn't|must|no one|nobody|`
    + `can|could|would|will|i|we|the|${REQUEST_VERB})\\b)`,
  'giu',
);

function clauses(text: string): string[] {
  return text.replace(newClause, ';').split(/\s*[;:]\s*|[.!?]+(?=\s|$)/u)
    .map(clause => clause.trim()).filter(Boolean);
}

function directed(clause: string): boolean {
  return requestStart.test(clause) || questionVerb.test(clause)
    || /^(?:can|could|may)\s+i\s+(?:have|get|see|use)\b/iu.test(clause)
    || /^(?:what\s+is|what's)\s+your\b/iu.test(clause)
    || /^(?:i|we)\s+need\s+your\b/iu.test(clause);
}

function isCaution(clause: string): boolean {
  const warning = caution.exec(clause);
  const verb = anyVerb.exec(clause);
  return warning !== null && (verb === null || warning.index < verb.index);
}

function isHowTo(clause: string): boolean {
  return /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:show|tell)\s+me\s+how\s+to\b/iu.test(clause);
}

function matchesClause(clause: string, config: Config): boolean {
  if (isCaution(clause) || isHowTo(clause)) return false;
  for (const pattern of config.credentialRequestPatterns) {
    if (!new RegExp(pattern, 'iu').test(clause)) continue;
    if (!DEFAULT_CREDENTIAL_REQUEST_PATTERNS.includes(pattern)) return true;
    if (directed(clause) || /^your\b/iu.test(clause)) return true;
  }
  return false;
}

// Decision 16: carry only an incomplete directed request into the immediately next clause.
export function containsCredentialRequest(text: string, config: Config): boolean {
  let carry = false;
  for (const clause of clauses(text)) {
    const warning = isCaution(clause);
    const request = directed(clause) && !isHowTo(clause);
    if (matchesClause(clause, config)) return true;
    if (carry && term.test(clause) && !warning && (!anyVerb.test(clause) || request)) return true;
    carry = request && !warning && !term.test(clause);
  }
  return false;
}
