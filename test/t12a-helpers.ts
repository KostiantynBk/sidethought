import { expect } from 'vitest';
import type { DeliberatorOutput, InterpreterOutput } from '../src/contract/index.js';
import { assembleContext } from '../src/context/index.js';
import { ResearchHarness } from './t11a-helpers.js';
import { readyOutput } from './t03-helpers.js';

export const scores = {
  consequence: 2,
  uncertainty: 2,
  answerable: true,
  urgency: 1,
  needsPrivateDetail: false,
};

export class ContributionHarness extends ResearchHarness {
  connect(): void {
    this.send('client.connected', { modality: 'text' });
  }

  timer(purpose: string): void {
    const timer = this.state.domain.timers.find(value => value.purpose === purpose);
    expect(timer, `missing timer ${purpose}`).toBeDefined();
    this.at = Math.max(this.at, timer!.dueAt - 1);
    this.send('timer.fired', { timerId: timer!.timerId, purpose });
  }

  statement(text: string, kind: 'requirement' | 'option' = 'requirement'): string {
    this.send('input.committed', { clientMsgId: `m-${this.at}`, text, modality: 'text' });
    const call = this.state.domain.call!;
    const inputId = call.inputIds[0]!;
    this.interpret({
      ...readyOutput,
      inputKinds: [{ inputId, kind: 'statement' }],
      ops: [{
        op: 'create',
        kind,
        status: 'stated',
        text,
        quoteSpans: [{ inputId, start: 0, end: text.length, quote: text }],
      }],
    });
    return Object.values(this.state.domain.items).find(value => value.text === text)!.id;
  }

  interpret(output?: InterpreterOutput): void {
    const call = this.state.domain.call!;
    this.send('interpretation.ready', {
      requestId: call.requestId,
      callId: call.callId,
      output: output ?? {
        ...readyOutput,
        inputKinds: call.inputIds.map(inputId => ({ inputId, kind: 'statement' })),
      },
    });
  }

  passReply(): void {
    if (this.state.domain.reply?.status !== 'streaming') this.timer('replyDebounce');
    const reply = this.state.domain.reply!;
    const owner = { requestId: reply.requestId, callId: reply.callId };
    this.send('reply.chunk', { ...owner, text: '[PASS]' });
    this.send('reply.done', owner);
  }

  nominate(nominations: DeliberatorOutput['nominations']): void {
    if (!this.state.domain.initiative.deliberation) this.timer('deliberationDebounce');
    const call = this.state.domain.initiative.deliberation!;
    const context = assembleContext(this.state, {
      type: 'llm.call',
      role: 'deliberator',
      requestId: call.requestId,
      callId: call.callId,
      basisRev: call.basisRev,
      capturedInputs: call.capturedInputs,
    });
    expect(context.instructions).toContain('deliberator-v4');
    this.send('deliberation.ready', {
      requestId: call.requestId,
      callId: call.callId,
      output: { nominations },
    });
  }

  check(utterance?: string): void {
    const candidate = Object.values(this.state.domain.initiative.candidates).find(value => value.state === 'checking')!;
    expect(candidate).toBeDefined();
    const call = candidate.check!;
    const payload = JSON.parse(assembleContext(this.state, {
      type: 'llm.call',
      role: 'checker',
      requestId: call.requestId,
      callId: call.callId,
      basisRev: call.basisRev,
      capturedInputs: call.capturedInputs,
    }).input).candidate;
    this.send('check.ready', {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        applies: true,
        reason: 'Supported and current',
        utterance: utterance ?? payload.claims?.[0]?.text ?? payload.text,
        claimsUsed: payload.claims?.length ? [payload.claims[0].id] : [],
      },
    });
  }

  acknowledge(): void {
    const candidate = Object.values(this.state.domain.initiative.candidates).find(value => value.state === 'delivering')!;
    expect(candidate).toBeDefined();
    const delivery = this.state.domain.deliveries[candidate.deliveryId!]!;
    const chunkIdx = delivery.chunks.findLastIndex(chunk => chunk.state === 'sent');
    this.send('delivery.progress', {
      deliveryId: delivery.id,
      chunkIdx,
      chars: delivery.sentChars,
      final: !!delivery.doneSent,
      reason: 'rendered',
    });
  }
}
