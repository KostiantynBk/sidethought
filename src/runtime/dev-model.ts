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
        output: { nominations: [] },
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
