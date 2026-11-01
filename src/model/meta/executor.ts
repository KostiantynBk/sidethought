import type OpenAI from 'openai';
import { CheckerOutputSchema, DeliberatorOutputSchema, InterpreterOutputSchema } from '../../contract/roles.js';
import { assembleContext, type CallEffect, type RolePrompt } from '../../context/index.js';
import type { State } from '../../kernel/index.js';
import type { ModelEffect, ModelExecutor, RawEvent } from '../../runtime/model-port.js';
import type { MetaPrices } from './config.js';
import { requestBody } from './request.js';
import { normalizeInterpreterWire } from './schema.js';
import { object, readEvents } from './stream.js';
import { tokenUsage, type TokenUsage } from './usage.js';

type Context = Parameters<ModelExecutor['handle']>[1];
export type CallMetric = {
  callId: string;
  requestId: string;
  role: string;
  startedAt: number;
  firstDeltaMs?: number;
  terminalMs?: number;
  terminalType?: string;
  outcome?: string;
  providerResponseId?: string;
  outputChars: number;
  schemaValid?: boolean;
  locallyAborted?: boolean;
  usage?: TokenUsage;
};
type Attempt = {
  effect: CallEffect;
  ctx: Context;
  controller: AbortController;
  metric: CallMetric;
  text: string;
  chunk: number;
  suppliedLessons?: RolePrompt['suppliedLessons'];
};
export type MetaOptions = {
  assemble?: (state: State, effect: CallEffect) => RolePrompt;
  now?: () => number;
  onMetric?: (metric: Readonly<CallMetric>) => void;
};
const terminals = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);

export class MetaModel implements ModelExecutor {
  readonly metrics = new Map<string, CallMetric>();
  private readonly active = new Map<string, Attempt>();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  private readonly assemble;
  private readonly now;

  constructor(private readonly client: OpenAI, private readonly prices: MetaPrices,
    private readonly options: MetaOptions = {}) {
    this.assemble = options.assemble ?? assembleContext;
    this.now = options.now ?? Date.now;
  }

  handle(effect: ModelEffect, ctx: Context): void {
    if (effect.type === 'llm.abort') {
      this.active.get(effect.callId)?.controller.abort();
      return;
    }
    if (this.closed || this.metrics.has(effect.callId)) return;
    const attempt: Attempt = {
      effect,
      ctx,
      controller: new AbortController(),
      metric: {
        callId: effect.callId,
        requestId: effect.requestId,
        role: effect.role,
        startedAt: this.now(),
        outputChars: 0,
      },
      text: '',
      chunk: 0,
    };
    this.metrics.set(effect.callId, attempt.metric);
    this.active.set(effect.callId, attempt);
    const task = this.run(attempt);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private emit(attempt: Attempt, suffix: string, type: string, payload: unknown): void {
    if (attempt.controller.signal.aborted) return;
    const event: RawEvent = {
      eventId: `${attempt.effect.callId}:${suffix}`,
      sessionId: attempt.ctx.state.sessionId,
      type,
      payload,
    };
    attempt.ctx.emit(event);
  }

  private identity(attempt: Attempt) {
    return {
      requestId: attempt.effect.requestId,
      callId: attempt.effect.callId,
    };
  }

  private fail(attempt: Attempt, reason: string): void {
    attempt.metric.outcome = reason;
    const role = attempt.effect.role;
    const type = role === 'interpreter' ? 'interpretation.failed'
      : role === 'responder' ? 'reply.failed'
        : role === 'deliberator' ? 'deliberation.failed' : role === 'checker' ? 'check.failed' : undefined;
    if (type) this.emit(attempt, 'failed', type, {
      ...this.identity(attempt),
      reason,
    });
  }

  private async run(attempt: Attempt): Promise<void> {
    try {
      if (!['interpreter', 'responder', 'deliberator', 'checker'].includes(attempt.effect.role)) {
        this.fail(attempt, 'unsupported_role');
        return;
      }
      const { state } = attempt.ctx;
      const prompt = this.assemble(state, attempt.effect);
      attempt.suppliedLessons = prompt.suppliedLessons;
      const body = requestBody(state, attempt.effect, prompt);
      const response = await this.client.responses.create(body, {
        signal: attempt.controller.signal,
      }).asResponse();
      await this.consume(attempt, response);
    } catch {
      // §11.3: provider/SDK/validation exceptions may contain credentials or content. Never forward them.
      if (!attempt.controller.signal.aborted) this.fail(attempt, 'model_error');
    } finally {
      this.active.delete(attempt.effect.callId);
      attempt.metric.terminalMs ??= this.now() - attempt.metric.startedAt;
      if (attempt.controller.signal.aborted) {
        attempt.metric.locallyAborted = true;
        // A kernel output check may abort synchronously after a terminal result. Keep its cap/failure meter.
        attempt.metric.outcome ??= 'aborted';
      }
      try {
        this.options.onMetric?.(structuredClone(attempt.metric));
      } catch {
        // Observability must not alter kernel outcomes or expose logger exceptions.
      }
    }
  }

  private async consume(attempt: Attempt, response: Response): Promise<void> {
    for await (const event of readEvents(response, attempt.controller.signal)) {
      if (attempt.controller.signal.aborted) return;
      const providerResponse = object(event.response);
      if (typeof providerResponse?.id === 'string') attempt.metric.providerResponseId = providerResponse.id;
      if (event.type === 'response.output_text.delta') this.delta(attempt, event.delta);
      if (terminals.has(event.type)) {
        attempt.metric.terminalType = event.type;
        attempt.metric.terminalMs = this.now() - attempt.metric.startedAt;
        this.terminal(attempt, event.type, providerResponse, event.usage);
        return;
      }
    }
    if (!attempt.controller.signal.aborted) this.fail(attempt, 'missing_terminal');
  }

  private delta(attempt: Attempt, value: unknown): void {
    if (typeof value !== 'string') throw new Error('invalid_delta');
    attempt.metric.firstDeltaMs ??= this.now() - attempt.metric.startedAt;
    attempt.metric.outputChars += value.length;
    if (attempt.effect.role !== 'responder') {
      attempt.text += value;
    } else {
      this.emit(attempt, `chunk:${attempt.chunk++}`, 'reply.chunk', {
        ...this.identity(attempt),
        text: value,
      });
    }
  }

  private terminal(attempt: Attempt, type: string, response?: Record<string, unknown>, rawUsage?: unknown): void {
    const usage = tokenUsage(response?.usage ?? rawUsage, this.prices);
    if (usage) {
      attempt.metric.usage = usage;
      this.emit(attempt, 'usage', 'llm.usage', {
        callId: attempt.effect.callId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        queries: 0,
        audioSeconds: 0,
        costUsd: usage.costUsd,
      });
    }
    if (attempt.controller.signal.aborted) return;
    const capped = type === 'response.incomplete'
      && object(response?.incomplete_details)?.reason === 'max_output_tokens';
    if (capped && attempt.effect.role !== 'responder') {
      this.fail(attempt, 'output_cap');
    } else if (type === 'response.completed' || (capped && attempt.effect.role === 'responder')) {
      attempt.metric.outcome = capped ? 'cap_reached' : 'completed';
      this.complete(attempt);
    } else {
      this.fail(attempt, type === 'response.incomplete' ? 'incomplete' : 'provider_failed');
    }
  }

  private complete(attempt: Attempt): void {
    if (attempt.effect.role === 'responder') {
      this.emit(attempt, 'done', 'reply.done', this.identity(attempt));
      return;
    }
    let output: unknown;
    try {
      output = JSON.parse(attempt.text);
    } catch {
      attempt.metric.schemaValid = false;
      this.fail(attempt, 'invalid_json');
      return;
    }
    const role = attempt.effect.role;
    const result = role === 'interpreter' ? InterpreterOutputSchema.safeParse(normalizeInterpreterWire(output))
      : role === 'deliberator' ? DeliberatorOutputSchema.safeParse(output)
        : CheckerOutputSchema.safeParse(output);
    attempt.metric.schemaValid = result.success;
    if (!result.success) {
      this.fail(attempt, 'invalid_schema');
      return;
    }
    const type = role === 'interpreter' ? 'interpretation.ready'
      : role === 'deliberator' ? 'deliberation.ready' : 'check.ready';
    this.emit(attempt, 'ready', type, {
      ...this.identity(attempt),
      ...(role === 'deliberator' && attempt.suppliedLessons
        ? { suppliedLessons: attempt.suppliedLessons } : {}),
      output: result.data,
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const attempt of this.active.values()) attempt.controller.abort();
    await Promise.all(this.pending);
  }
}
