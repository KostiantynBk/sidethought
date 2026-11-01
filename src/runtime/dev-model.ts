import { randomUUID } from 'node:crypto';
import type { ModelEffect, ModelExecutor, RawEvent } from './model-port.js';
import type { State } from '../kernel/index.js';

type Context = { state: State; emit: (event: RawEvent) => void };

function devResearchRequests(state: State, inputIds: string[]) {
  return state.domain.inputs.flatMap(input => {
    if (!inputIds.includes(input.id) || input.origin === 'assistant') return [];
    const match = /^\s*check whether\s+(.+?)\s+works offline[?.!]?\s*$/iu.exec(input.text);
    if (!match) return [];
    const question = input.text.trim();
    return [{
      inputId: input.id,
      question,
      publicQuery: question,
      depItemIds: [],
    }];
  });
}

function devNominations(state: State, effect: Extract<ModelEffect, { type: 'llm.call' }>) {
  const items = effect.capturedInputs.flatMap(dep => {
    const item = state.domain.items[dep.itemId];
    return item && item.contentVersion === dep.contentVersion && item.status === 'stated' ? [item] : [];
  });
  for (let left = 0; left < items.length; left++) {
    for (let right = left + 1; right < items.length; right++) {
      const first = items[left]!;
      const second = items[right]!;
      const words = new Set(first.text.toLowerCase().match(/[a-z]{5,}/g) ?? []);
      const topic = (second.text.toLowerCase().match(/[a-z]{5,}/g) ?? []).find(word => words.has(word));
      if (!topic) continue;
      return [{
        kind: 'insight',
        topic,
        depItemIds: [first.id, second.id],
        insight: `Consider these together: ${first.text} ${second.text}`,
        scores: {
          consequence: 1,
          uncertainty: 0,
          answerable: false,
          urgency: 0,
          needsPrivateDetail: false,
        },
      }];
    }
  }
  return [];
}

export class DevModel implements ModelExecutor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  handle(effect: ModelEffect, ctx: Context): void {
    if (effect.type === 'llm.abort') {
      this.cancel(effect.callId);
      return;
    }
    if (effect.role === 'interpreter') {
      const inputIds = ctx.state.domain.call?.callId === effect.callId ? ctx.state.domain.call.inputIds : [];
      this.emit(ctx, 'interpretation.ready', {
        requestId: effect.requestId,
        callId: effect.callId,
        output: {
          inputKinds: inputIds.map(inputId => ({ inputId, kind: 'statement' })),
          ops: [],
          replacementGroups: [],
          researchRequests: devResearchRequests(ctx.state, inputIds),
          deprioritizedTopics: [],
          voiceConfirmValues: [],
        },
      });
    } else if (effect.role === 'responder') {
      this.stream(effect, ctx);
    } else if (effect.role === 'deliberator') {
      this.emit(ctx, 'deliberation.ready', {
        requestId: effect.requestId,
        callId: effect.callId,
        output: { nominations: devNominations(ctx.state, effect) },
      });
    } else if (effect.role === 'checker') {
      // T12a owns the candidate context shape. Fail closed until the seam is integrated.
      this.emit(ctx, 'check.failed', {
        requestId: effect.requestId,
        callId: effect.callId,
        reason: 'candidate_context_unavailable',
      });
    }
  }

  private stream(effect: Extract<ModelEffect, { type: 'llm.call' }>, ctx: Context): void {
    const fragments = ['This is ', 'a synthetic dev reply. ', 'No real AI ', 'was called.'];
    const next = (index: number) => {
      if (index === fragments.length) {
        this.timers.delete(effect.callId);
        this.emit(ctx, 'reply.done', { requestId: effect.requestId, callId: effect.callId });
        return;
      }
      this.emit(ctx, 'reply.chunk', {
        requestId: effect.requestId,
        callId: effect.callId,
        text: fragments[index],
      });
      if (this.timers.has(effect.callId)) {
        this.timers.set(effect.callId, setTimeout(() => next(index + 1), 150));
      }
    };
    this.timers.set(effect.callId, setTimeout(() => next(0), 150));
  }

  private emit(ctx: Context, type: string, payload: unknown): void {
    ctx.emit({ eventId: randomUUID(), sessionId: ctx.state.sessionId, type, payload });
  }

  private cancel(callId: string): void {
    const timer = this.timers.get(callId);
    if (timer) clearTimeout(timer);
    this.timers.delete(callId);
  }

  async shutdown(): Promise<void> {
    for (const callId of this.timers.keys()) this.cancel(callId);
  }
}
