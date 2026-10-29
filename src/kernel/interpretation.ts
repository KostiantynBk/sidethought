import type { Config } from '../config/index.js';
import { AppliedPatchBatchSchema, type InterpreterOutput, type Item } from '../contract/index.js';
import type { Call, Context } from './index.js';
import { createItem, setStatus, supersedeItem, updateItem, verbalAgreement, type QuoteInput } from './items/index.js';
import { normalize, resolveQuoteSpan, spansMatch } from './items/spans.js';

type Op = InterpreterOutput['ops'][number];
type Local = Map<string, string>;
type Work = {
  items: Record<string, Item>;
  projectRev: number;
};

function inputs(_context: Context, call: Call, _config: Config): QuoteInput[] {
  return call.quoteWitness.sources;
}

function allOps(output: InterpreterOutput): Op[] {
  return [...output.ops, ...output.replacementGroups.flatMap(group => group.ops)];
}

function resolveOutput(context: Context, output: InterpreterOutput, call: Call, config: Config): InterpreterOutput {
  const sources = inputs(context, call, config);
  const resolve = (span: Op['quoteSpans'][number]) => {
    const result = resolveQuoteSpan(span, sources.find(input => input.id === span.inputId));
    if (result.decision) context.itemDecisions.push(result.decision);
    return result.span;
  };
  const resolveOp = (op: Op): Op => {
    const quoteSpans = op.quoteSpans.map(resolve);
    if (op.op !== 'supersede') return { ...op, quoteSpans };
    return {
      ...op,
      quoteSpans,
      replacement: {
        ...op.replacement,
        quoteSpans: op.replacement.quoteSpans.map(resolve),
      },
    };
  };
  return {
    ...output,
    ops: output.ops.map(resolveOp),
    replacementGroups: output.replacementGroups.map(group => ({
      ...group,
      ops: group.ops.map(resolveOp),
    })),
  };
}

function refFor(op: Op): string | undefined {
  if (op.op === 'create') return op.localRef;
  if (op.op === 'supersede') return op.replacement.localRef;
  return undefined;
}

// Required evidence must be checked before any op or request is staged (AD-5, T06 decision 7).
function missingRequiredSpans(op: Op): boolean {
  if (op.op === 'create') {
    return (op.status === 'stated' || op.status === 'considering') && op.quoteSpans.length === 0;
  }
  if (op.op === 'retract' || op.op === 'reject') return op.quoteSpans.length === 0;
  if (op.op === 'supersede') return op.quoteSpans.length === 0 || op.replacement.quoteSpans.length === 0;
  return false;
}

function validate(context: Context, output: InterpreterOutput, call: Call, config: Config): boolean {
  const ops = allOps(output);
  const kinds = output.inputKinds.map(entry => entry.inputId);
  if (kinds.length !== call.inputIds.length || new Set(kinds).size !== kinds.length
    || kinds.some(id => !call.inputIds.includes(id))) return false;
  const refs = ops.map(refFor).filter((ref): ref is string => ref !== undefined);
  const captured = new Set(call.capturedInputs.map(item => item.itemId));
  if (new Set(refs).size !== refs.length || refs.some(ref => captured.has(ref) || !/^new:[0-9]{1,4}$/.test(ref))) {
    return false;
  }
  if (ops.some(op => 'itemId' in op && !captured.has(op.itemId) && !refs.includes(op.itemId))) return false;
  if (output.researchRequests.some(request => !call.inputIds.includes(request.inputId)
    || request.depItemIds.some(id => !captured.has(id) && !refs.includes(id)))) return false;
  const spans = ops.flatMap(op => op.op === 'supersede'
    ? [...op.quoteSpans, ...op.replacement.quoteSpans]
    : op.quoteSpans);
  if (ops.some(missingRequiredSpans) || !spansMatch(spans, inputs(context, call, config))) {
    context.itemDecisions.push('span:mismatch');
    return false;
  }
  return true;
}

function conflict(context: Context, output: InterpreterOutput, call: Call): boolean {
  const bind = (op: Op) => {
    if (!('itemId' in op)) return op;
    const captured = call.capturedInputs.find(item => item.itemId === op.itemId);
    // Same-output local references have no captured version; they are checked after creation.
    return {
      ...op,
      seenContentVersion: captured?.contentVersion ?? 1,
    };
  };
  const batch = AppliedPatchBatchSchema.parse({
    requestId: call.requestId,
    callId: call.callId,
    ops: output.ops.map(bind),
    replacementGroups: output.replacementGroups.map(group => ({ ops: group.ops.map(bind) })),
  });
  return [...batch.ops, ...batch.replacementGroups.flatMap(group => group.ops)].some(op => {
    if (!('itemId' in op)) return false;
    const captured = call.capturedInputs.some(item => item.itemId === op.itemId);
    return captured && context.domain.items[op.itemId]?.contentVersion !== op.seenContentVersion;
  });
}

function proposal(op: Extract<Op, { op: 'create' }> | Extract<Op, { op: 'supersede' }>['replacement']) {
  return {
    ...op,
    origin: op.status === 'proposed' ? 'assistant' as const : 'user' as const,
    source: 'interpreter' as const,
    private: false,
  };
}

function create(work: Work, op: Extract<Op, { op: 'create' }>, context: Context, call: Call, config: Config) {
  const [sessionId, seq, n] = context.id().split('.');
  const id = `${sessionId}.${seq}.${n}`;
  const result = createItem(work, {
    ...proposal(op),
    voiceOrigin: context.domain.inputs.some(input => call.inputIds.includes(input.id) && input.modality === 'voice'),
  }, inputs(context, call, config), config, {
    sessionId: sessionId!,
    seq: Number(seq),
    n: Number(n),
  });
  return {
    ...result,
    id,
  };
}

function applyOne(work: Work, op: Op, local: Local, context: Context, call: Call, config: Config) {
  if (op.op === 'create') {
    const result = create(work, op, context, call, config);
    if (result.state !== work && op.localRef) local.set(op.localRef, result.id);
    return result;
  }
  const target = local.get(op.itemId) ?? op.itemId;
  if (op.op === 'update') return updateItem(work, target, op.text, 'interpreter');
  if (op.op === 'retract' || op.op === 'reject') {
    return setStatus(work, target, op.op === 'retract' ? 'retracted' : 'rejected',
      'interpreter', op.quoteSpans, inputs(context, call, config), config);
  }
  const old = work.items[target];
  if (!old) return {
    state: work,
    decisions: ['item:not_found'],
  };
  if (normalize(old.text) === normalize(op.replacement.text)) {
    return {
      state: work,
      decisions: ['patch:noop_identical'],
    };
  }
  const status = setStatus(
    work, target, 'superseded', 'interpreter', op.quoteSpans, inputs(context, call, config), config,
  );
  if (status.state === work) return status;
  const fresh = create(work, {
    op: 'create',
    ...op.replacement,
  }, context, call, config);
  if (fresh.state === work) return fresh;
  const replacement = fresh.state.items[fresh.id]!;
  const result = supersedeItem(work, target, replacement, 'interpreter', inputs(context, call, config), config);
  if (result.state !== work && op.replacement.localRef) local.set(op.replacement.localRef, fresh.id);
  return result;
}

function applyUnit(work: Work, ops: Op[], grouped: boolean, local: Local,
  context: Context, call: Call, config: Config): Work {
  let next = work;
  const refs = new Map(local);
  const reasons: string[] = [];
  for (const op of ops) {
    const result = applyOne(next, op, refs, context, call, config);
    reasons.push(...result.decisions);
    if (grouped && result.state === next && !result.decisions.includes('patch:noop_identical')) {
      context.itemDecisions.push(...reasons, 'patch:group_rejected');
      return work;
    }
    next = result.state;
  }
  for (const [ref, id] of refs) local.set(ref, id);
  context.itemDecisions.push(...reasons);
  return next;
}

function applyRequests(context: Context, output: InterpreterOutput, call: Call, local: Local, config: Config): void {
  const counts: Record<string, number> = {};
  for (const request of output.researchRequests) {
    counts[request.inputId] = (counts[request.inputId] ?? 0) + 1;
    if (counts[request.inputId]! > config.maxResearchRequestsPerInput) {
      context.itemDecisions.push('research:over_limit');
      continue;
    }
    const deps = request.depItemIds.flatMap(id => {
      const captured = call.capturedInputs.find(dep => dep.itemId === id);
      if (captured) return [captured];
      const item = context.domain.items[local.get(id) ?? ''];
      if (item) return [{
        itemId: item.id,
        contentVersion: item.contentVersion,
      }];
      context.itemDecisions.push('research:dep_dropped');
      return [];
    });
    context.domain.pendingRequests.push({
      ...request,
      depItemIds: deps.map(dep => dep.itemId),
      deps,
      promised: true,
    });
  }
}

export function applyInterpretation(context: Context, output: InterpreterOutput, call: Call, config: Config):
  'invalid' | 'conflict' | 'applied' {
  output = resolveOutput(context, output, call, config);
  if (!validate(context, output, call, config)) return 'invalid';
  if (conflict(context, output, call)) return 'conflict';
  const local: Local = new Map();
  let work: Work = {
    items: context.domain.items,
    projectRev: context.domain.projectRev,
  };
  const original = work.projectRev;
  for (const op of output.ops) work = applyUnit(work, [op], false, local, context, call, config);
  for (const group of output.replacementGroups) work = applyUnit(work, group.ops, true, local, context, call, config);
  for (const id of output.agreesWith ?? []) {
    if (!call.capturedInputs.some(dep => dep.itemId === id) || work.items[id]?.status !== 'proposed') {
      context.itemDecisions.push('agree:invalid_target');
    } else {
      const result = verbalAgreement(work, id);
      work = result.state;
      context.itemDecisions.push(...result.decisions);
    }
  }
  context.domain.items = work.items;
  context.domain.projectRev = original + (work.projectRev !== original ? 1 : 0);
  if (output.clarification !== undefined) {
    context.domain.clarifications.push({
      inputIds: call.inputIds,
      clarification: output.clarification,
    });
  }
  context.domain.deprioritizedTopics = [...new Set([
    ...context.domain.deprioritizedTopics,
    ...output.deprioritizedTopics,
  ])];
  applyRequests(context, output, call, local, config);
  return 'applied';
}
