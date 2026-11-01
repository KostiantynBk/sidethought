import type { CheckerOutput, KernelEvent } from '../../contract/index.js';
import type { Context } from '../state.js';
import { containsCredentialRequest } from '../output-credentials.js';
import { containsUnapprovedUrl } from '../output-url.js';
import { ABBREVIATION } from '../output-normalization.js';
import { consistentClaim } from '../research/support.js';
import { dependencyState } from '../research/policy.js';
import { publishFinding } from '../research/findings.js';
import { arm, capturedInputs, clearTimer, transition } from './common.js';
import { candidatePayload } from './payload.js';
import type { Contribution } from './types.js';

export function sentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]+["'”’)\]]*\s+/gu)) {
    const end = match.index + match[0].length;
    if (ABBREVIATION.test(text.slice(start, end).trimEnd())) continue;
    parts.push(text.slice(start, end));
    start = end;
  }
  if (text.slice(start).trim()) parts.push(text.slice(start));
  return parts;
}

export function startCheck(context: Context, candidate: Contribution, at: number): void {
  const callId = context.id();
  candidate.check = {
    callId,
    requestId: context.id(),
    basisRev: context.domain.projectRev,
    capturedInputs: capturedInputs(context),
    inputCount: context.domain.inputs.length,
    deadlineTimerId: arm(context, 'checkTimeout', at + context.config.checkerTimeoutMs, callId),
  };
  candidate.checkedAtRev = context.domain.projectRev;
  transition(context, candidate, 'checking', 'check:started');
  context.effects.push({
    type: 'llm.call',
    role: 'checker',
    requestId: candidate.check.requestId,
    callId,
    basisRev: candidate.check.basisRev,
    capturedInputs: candidate.check.capturedInputs,
  });
}

export function outputFailure(context: Context, candidate: Contribution, output: CheckerOutput): string | undefined {
  const text = output.utterance.trim();
  if (!text || sentences(text).length > Math.min(2, context.config.maxCheckerSentences)) return 'sentences';
  if (containsCredentialRequest(text, context.config)) return 'credentials';
  const payload = candidatePayload(context.domain, candidate);
  const claims = 'claims' in payload ? payload.claims : [];
  if (candidate.payload === 'evidence') {
    if (!output.claimsUsed.length || output.claimsUsed.some(id => !claims.some(claim => claim.id === id))) {
      return 'claims';
    }
  } else if (output.claimsUsed.length) return 'claims';
  const selected = claims.filter(claim => output.claimsUsed.includes(claim.id));
  // Only the claims actually approved by the Checker may authorize evidence words and URLs.
  const basis = candidate.payload === 'evidence' ? selected.map(claim => claim.text).join(' ')
    : candidate.payload === 'inference' ? ('citedItems' in payload ? payload.citedItems : []).map(item => item.text).join(' ')
      : candidate.text;
  const urls = selected.flatMap(claim => claim.support.map(support => support.url));
  if (containsUnapprovedUrl(text, urls)) return 'url';
  const withoutUrls = urls.reduce((value, url) => value.split(url).join(''), text);
  if (!consistentClaim(withoutUrls, basis)) return 'payload_tokens';
  return undefined;
}

function rebase(context: Context, candidate: Contribution, callId: string): void {
  const validity = dependencyState(candidate.deps, context.domain.items);
  if (!validity.edited.length) return;
  const from = structuredClone(candidate.deps);
  const to = candidate.deps.map(dep => ({
    itemId: dep.itemId,
    contentVersion: context.domain.items[dep.itemId]!.contentVersion,
  }));
  const witness = {
    atRev: context.domain.projectRev,
    checkerCallId: callId,
    from,
    to,
  };
  candidate.rebases.push(witness);
  candidate.deps = to;
  const finding = candidate.source.findingId ? context.domain.findings[candidate.source.findingId] : undefined;
  if (finding) {
    finding.deps = structuredClone(to);
    finding.rebases.push(structuredClone(witness));
    finding.validity = { state: 'current' };
    publishFinding(context, finding);
  }
}

export function checkEvent(
  context: Context,
  event: Extract<KernelEvent, { type: 'check.ready' | 'check.failed' }>,
): string {
  const candidate = Object.values(context.domain.initiative.candidates).find(value => value.state === 'checking'
    && value.check?.callId === event.payload.callId && value.check.requestId === event.payload.requestId);
  if (!candidate?.check) return 'late:retired_check';
  const check = candidate.check;
  const deadline = context.domain.timers.find(timer => timer.timerId === check.deadlineTimerId)?.dueAt;
  clearTimer(context, check.deadlineTimerId);
  delete candidate.check;
  if (deadline !== undefined && event.acceptedAt! >= deadline) {
    transition(context, candidate, 'card_only', 'check:timeout');
  } else if (check.basisRev !== context.domain.projectRev || check.inputCount !== context.domain.inputs.length) {
    candidate.rechecks += 1;
    const retry = candidate.rechecks <= Math.min(1, context.config.maxCheckerRechecks);
    transition(context, candidate, retry ? 'candidate' : 'card_only', retry ? 'check:revision_retry' : 'check:revision_card');
  } else if (event.type === 'check.failed') {
    transition(context, candidate, 'card_only', 'check:failed');
  } else {
    acceptCheck(context, candidate, event.payload.output, check.callId, event.acceptedAt!);
  }
  return 'check:resolved';
}

function acceptCheck(context: Context, candidate: Contribution, output: CheckerOutput, callId: string, at: number) {
  const failure = !output.applies ? 'obsolete' : outputFailure(context, candidate, output);
  if (failure) {
    transition(context, candidate, 'card_only', `check:${failure}`);
    return;
  }
  const invalid = dependencyState(candidate.deps, context.domain.items).removed;
  if (invalid) {
    transition(context, candidate, candidate.payload === 'evidence' ? 'card_only' : 'dropped', `validity:${invalid}`);
    return;
  }
  rebase(context, candidate, callId);
  candidate.checkCallId = callId;
  candidate.checkedClaims = [...output.claimsUsed];
  candidate.checkedInputCount = context.domain.inputs.length;
  candidate.utterance = output.utterance.trim();
  // A valid result cannot bypass floor changes during the call (e.g. composer activity).
  transition(context, candidate, 'candidate', 'check:passed');
}

export function checkDeadline(context: Context, timerId: string): boolean {
  const candidate = Object.values(context.domain.initiative.candidates).find(value => value.state === 'checking'
    && value.check?.deadlineTimerId === timerId);
  if (!candidate?.check) return false;
  context.effects.push({
    type: 'llm.abort',
    callId: candidate.check.callId,
  });
  delete candidate.check;
  transition(context, candidate, 'card_only', 'check:timeout');
  return true;
}
