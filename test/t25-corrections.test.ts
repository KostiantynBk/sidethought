import { expect, it } from 'vitest';
import { assembleContext, type CallEffect } from '../src/context/index.js';
import { INTERPRETER_PROMPT, INTERPRETER_PROMPT_VERSION } from '../src/context/prompts/interpreter.js';
import type { InterpreterOutput } from '../src/contract/index.js';
import { repairInterpreterSpans } from '../src/model/meta/interpreter-spans.js';
import { readyOutput } from './t03-helpers.js';
import { delta, finished, setup, terminal } from './t09-helpers.js';
import { ContributionHarness } from './t12a-helpers.js';
import { item } from './t11a-helpers.js';

const correction = 'Actually, we will use the Supabase Pro plan from day one.';

function correctionOutput(inputId: string, oldOp: 'reject' | 'retract' = 'reject'): InterpreterOutput {
  const quoteSpans = [{
    inputId,
    start: 10,
    end: correction.length,
    quote: correction.slice(10),
  }];
  return {
    ...readyOutput,
    inputKinds: [{ inputId, kind: 'correction' }],
    replacementGroups: [{ ops: [{
      op: oldOp,
      itemId: 'r1',
      quoteSpans,
    }, {
      op: 'create',
      kind: 'decision',
      status: 'stated',
      text: 'Use Supabase Pro plan from day one',
      quoteSpans,
    }] }],
  };
}

function beginCorrection(h: ContributionHarness): InterpreterOutput {
  h.send('input.committed', {
    clientMsgId: 'correction',
    text: correction,
    modality: 'text',
  });
  return repairInterpreterSpans(correctionOutput(h.state.domain.call!.inputIds[0]!),
    h.state.domain.call!.quoteWitness.sources);
}

it('versions the Interpreter prompt as v3', () => {
  expect(INTERPRETER_PROMPT_VERSION).toBe('sidethought-interpreter-v3');
});

it('specifies status-based atomic corrections rather than superseding proposed items', () => {
  expect(INTERPRETER_PROMPT).toContain('stated/confirmed -> supersede');
  expect(INTERPRETER_PROMPT).toContain('proposed -> reject the old item AND create');
  expect(INTERPRETER_PROMPT).toContain('considering -> retract the old item AND create');
  expect(INTERPRETER_PROMPT).toContain('ONE replacementGroups entry');
  expect(INTERPRETER_PROMPT).toContain('NEVER use op update for an Interpreter correction');
  expect(INTERPRETER_PROMPT).toContain('"op":"reject"');
});

it('requires whole clauses including leading Actually OK so and Please', () => {
  expect(INTERPRETER_PROMPT).toContain('Quote whole clauses');
  expect(INTERPRETER_PROMPT).toContain('"Actually,"');
  expect(INTERPRETER_PROMPT).toContain('"OK so,"');
  expect(INTERPRETER_PROMPT).toContain('"Please ..."');
  expect(INTERPRETER_PROMPT).toContain('Never start a quote mid-clause');
});

it('shows captured item status in the Interpreter project snapshot', () => {
  const h = new ContributionHarness('memory');
  beginCorrection(h);
  const call = h.state.domain.call!;
  const effect: CallEffect = {
    type: 'llm.call',
    role: 'interpreter',
    requestId: call.requestId,
    callId: call.callId,
    basisRev: call.basisRev,
    capturedInputs: call.capturedInputs,
  };
  const input = JSON.parse(assembleContext(h.state, effect).input);
  expect(input.projectSnapshot.items[0]).toMatchObject({ id: 'r1', status: 'proposed' });
  h.store.close();
});

it('accepts repaired reject plus create atomically through interpretation.ready', () => {
  const h = new ContributionHarness('memory');
  const output = beginCorrection(h);
  const rev = h.state.domain.projectRev;
  h.interpret(output);
  expect(h.state.domain.items.r1?.status).toBe('rejected');
  expect(Object.values(h.state.domain.items).find(item => item.kind === 'decision')).toMatchObject({
    status: 'stated',
    text: 'Use Supabase Pro plan from day one',
  });
  expect(h.state.domain.projectRev).toBe(rev + 1);
  expect(h.state.domain.inputs.at(-1)?.status).toBe('interpreted');
  h.store.close();
});

it('accepts atomic retract plus create for an old considering item', () => {
  const h = new ContributionHarness('memory', {}, [{
    ...item(),
    status: 'considering',
  }]);
  beginCorrection(h);
  const call = h.state.domain.call!;
  h.interpret(repairInterpreterSpans(correctionOutput(call.inputIds[0]!, 'retract'), call.quoteWitness.sources));
  expect(h.state.domain.items.r1?.status).toBe('retracted');
  expect(Object.values(h.state.domain.items).find(value => value.kind === 'decision')?.status).toBe('stated');
  h.store.close();
});

type Spans = InterpreterOutput['ops'][number]['quoteSpans'];

function beginInput(h: ContributionHarness, text: string): { inputId: string; whole: Spans } {
  h.send('input.committed', {
    clientMsgId: 'withdrawal',
    text,
    modality: 'text',
  });
  const inputId = h.state.domain.call!.inputIds[0]!;
  return { inputId, whole: [{ inputId, start: 0, end: text.length, quote: text }] };
}

it('scopes status-based replacement rules to corrections that supply a replacement', () => {
  expect(INTERPRETER_PROMPT).toContain('For a correction that supplies a replacement, choose the operation');
  expect(INTERPRETER_PROMPT).toContain('the replacement actually supplied by the user');
  expect(INTERPRETER_PROMPT).not.toContain('create with kind decision, status stated, replacement text');
});

it('tells the Interpreter to withdraw without inventing a replacement', () => {
  expect(INTERPRETER_PROMPT).toContain('For a withdrawal without a replacement, emit reject alone');
  expect(INTERPRETER_PROMPT).toContain('Do not invent a replacement or a replacement group.');
});

it('accepts a standalone reject that withdraws a proposed item without a replacement', () => {
  const h = new ContributionHarness('memory');
  const { inputId, whole } = beginInput(h, 'Actually, drop that hosting option for now.');
  const before = Object.keys(h.state.domain.items).length;
  h.interpret({
    ...readyOutput,
    inputKinds: [{ inputId, kind: 'correction' }],
    ops: [{ op: 'reject', itemId: 'r1', quoteSpans: whole }],
  });
  expect(h.state.domain.items.r1?.status).toBe('rejected');
  expect(Object.keys(h.state.domain.items)).toHaveLength(before);
  h.store.close();
});

it('keeps a hedged non-decision replacement as considering', () => {
  const h = new ContributionHarness('memory');
  const { inputId, whole } = beginInput(h, 'Actually, maybe we will use the Supabase Pro plan instead.');
  h.interpret({
    ...readyOutput,
    inputKinds: [{ inputId, kind: 'correction' }],
    replacementGroups: [{ ops: [
      { op: 'reject', itemId: 'r1', quoteSpans: whole },
      { op: 'create', kind: 'option', status: 'considering', text: 'Maybe use Supabase Pro plan', quoteSpans: whole },
    ] }],
  });
  expect(h.state.domain.items.r1?.status).toBe('rejected');
  expect(Object.values(h.state.domain.items).find(value => value.id !== 'r1' && value.kind === 'option'))
    .toMatchObject({ status: 'considering' });
  h.store.close();
});

it('rolls back rejection when the grouped replacement quote omits substantive words', () => {
  const h = new ContributionHarness('memory');
  const output = beginCorrection(h);
  const create = output.replacementGroups[0]!.ops[1]!;
  create.quoteSpans[0] = {
    inputId: h.state.domain.call!.inputIds[0]!,
    start: 26,
    end: correction.length,
    quote: correction.slice(26),
  };
  h.interpret(output);
  expect(h.state.domain.items.r1?.status).toBe('proposed');
  expect(Object.values(h.state.domain.items).filter(item => item.kind === 'decision')).toHaveLength(0);
  h.store.close();
});

it('marks a finding depending on the rejected old option stale and never delivers its queued evidence', () => {
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.passReply();
  const output = beginCorrection(h);
  h.complete();
  const finding = Object.values(h.state.domain.findings)[0]!;
  const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.payload === 'evidence')!;
  expect(candidate.state).toBe('candidate');
  expect(finding.validity.state).toBe('current');
  h.interpret(output);
  expect(h.state.domain.findings[finding.id]?.validity.state).toBe('stale');
  h.passReply();
  h.timer('floorGap');
  const final = h.state.domain.initiative.candidates[candidate.id]!;
  expect(final.state).toBe('card_only');
  expect(final.deliveryId).toBeUndefined();
  h.store.close();
});

it('repairs nested supersede replacement spans without changing the operation', () => {
  const h = new ContributionHarness('memory');
  beginCorrection(h);
  const output = correctionOutput(h.state.domain.call!.inputIds[0]!);
  const create = output.replacementGroups[0]!.ops[1]!;
  if (create.op !== 'create') throw new Error('expected create');
  const original: InterpreterOutput = {
    ...output,
    replacementGroups: [],
    ops: [{
      op: 'supersede',
      itemId: 'r1',
      quoteSpans: create.quoteSpans,
      replacement: {
        kind: create.kind,
        status: create.status,
        text: create.text,
        quoteSpans: create.quoteSpans,
      },
    }],
  };
  const repaired = repairInterpreterSpans(original, h.state.domain.call!.quoteWitness.sources);
  expect(repaired.ops[0]?.op).toBe('supersede');
  expect(repaired.ops[0]?.quoteSpans[0]?.quote).toBe(correction);
  if (repaired.ops[0]?.op !== 'supersede') throw new Error('expected supersede');
  expect(repaired.ops[0].replacement.quoteSpans[0]?.quote).toBe(correction);
  h.store.close();
});

it('emits repaired atomic spans before the runtime can journal interpretation.ready', async () => {
  const output = correctionOutput('input');
  const test = setup('interpreter', [delta(JSON.stringify(output)), terminal()]);
  test.ctx.state.domain.call!.quoteWitness.sources = [{
    id: 'input',
    text: correction,
    origin: 'user',
    modality: 'text',
  }];
  test.model.handle(test.effect, test.ctx);
  await finished(test.model);
  const payload = test.emitted.find(event => event.type === 'interpretation.ready')?.payload as {
    output: InterpreterOutput;
  };
  expect(payload.output.replacementGroups[0]!.ops.map(op => op.quoteSpans[0])).toEqual([
    {
      inputId: 'input',
      start: 0,
      end: correction.length,
      quote: correction,
    },
    {
      inputId: 'input',
      start: 0,
      end: correction.length,
      quote: correction,
    },
  ]);
  expect(output.replacementGroups[0]!.ops[0]!.quoteSpans[0]!.start).toBe(10);
  await test.model.shutdown();
});
