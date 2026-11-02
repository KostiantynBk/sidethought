import type OpenAI from 'openai';
import type { Effect } from '../../contract/events.js';
import { InvestigatorOutputSchema, type InvestigatorOutput } from '../../contract/roles.js';
import { INVESTIGATOR_SEARCH_V1, INVESTIGATOR_STRUCTURE_V2 } from '../../context/prompts/investigator.js';
import type { State } from '../../kernel/index.js';
import type { RawEvent } from '../../runtime/model-port.js';
import type { MetaPrices } from './config.js';
import { extractEvidence } from './investigator-evidence.js';
import { appendExcerpts, type PageFetchStats } from './page-evidence.js';
import { fetchSearchPages, type StructurePage } from './investigator-pages.js';
import { defaultPageFetchIo, type PageFetchIo } from './page-fetch.js';
import { investigatorJsonSchema, normalizeInvestigatorWire } from './schema.js';
import { object, readEvents } from './stream.js';
import { tokenUsage } from './usage.js';

export type JobLookup = (state: State, jobId: string) => { publicQuery: string } | undefined;
export type JobEffect = Extract<Effect, { type: 'job.dispatch' | 'job.abort' }>;
export type JobContext = { state: State; emit: (event: RawEvent) => void };
export interface InvestigatorExecutor {
  handle(effect: JobEffect, context: JobContext): void;
  shutdown(): Promise<void>;
}
type Dispatch = Extract<JobEffect, { type: 'job.dispatch' }>;
type Attempt = {
  effect: Dispatch;
  context: JobContext;
  controller: AbortController;
  startController: AbortController;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  providerId?: string;
  stop?: 'cancelled' | 'timedOut';
  cancelPromise?: Promise<void>;
  terminal: boolean;
  searchMetered: boolean;
};

export class MetaInvestigator implements InvestigatorExecutor {
  private active = new Map<string, Attempt>();
  private pending = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private client: OpenAI,
    private prices: MetaPrices,
    private lookup: JobLookup,
    private onStage?: (
      stage: 'responseId' | 'searchDone' | 'structureDone' | 'pagesFetched',
      stats?: PageFetchStats,
    ) => void,
    private pageIo: PageFetchIo = defaultPageFetchIo,
  ) {}

  handle(effect: JobEffect, context: JobContext): void {
    if (effect.type === 'job.abort') {
      const attempt = this.active.get(effect.callId);
      if (attempt) this.stop(attempt, 'cancelled');
      return;
    }
    if (this.closed || this.active.has(effect.callId)) return;
    const attempt: Attempt = {
      effect,
      context,
      controller: new AbortController(),
      startController: new AbortController(),
      timer: setTimeout(() => this.stop(attempt, 'timedOut'), context.state.config.jobDeadlineMs),
      deadline: Date.now() + context.state.config.jobDeadlineMs,
      terminal: false,
      searchMetered: false,
    };
    this.active.set(effect.callId, attempt);
    const task = this.run(attempt);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private emit(attempt: Attempt, suffix: string, type: string, payload: unknown): void {
    if (attempt.terminal) return;
    attempt.context.emit({
      eventId: `${attempt.effect.callId}:${suffix}`,
      sessionId: attempt.context.state.sessionId,
      type,
      payload,
    });
  }

  private identity(attempt: Attempt) {
    return { jobId: attempt.effect.jobId, callId: attempt.effect.callId };
  }

  private stop(attempt: Attempt, kind: 'cancelled' | 'timedOut'): void {
    if (attempt.stop || attempt.terminal) return;
    if (kind === 'timedOut' && !attempt.searchMetered) {
      // §4.5: a timed-out background response may still incur up to three queries per tool call.
      this.usage(attempt, 'search:estimated-usage', undefined, 9);
    }
    attempt.stop = kind;
    attempt.controller.abort();
    if (kind === 'timedOut' && !attempt.providerId) attempt.startController.abort();
    if (attempt.providerId) {
      void this.cancel(attempt);
    } else if (kind === 'timedOut') {
      // Report the local deadline now; cancel the provider if an ID arrives later.
      this.emit(attempt, kind, `job.${kind}`, this.identity(attempt));
      attempt.terminal = true;
    }
  }

  private cancel(attempt: Attempt): Promise<void> {
    if (attempt.cancelPromise) return attempt.cancelPromise;
    const id = attempt.providerId;
    attempt.cancelPromise = (async () => {
      if (id) {
        try {
          await this.client.responses.cancel(id);
        } catch {
          // Cancellation is best effort; errors may include response content or credentials.
        }
      }
      if (!attempt.terminal && attempt.stop) {
        this.emit(attempt, attempt.stop, `job.${attempt.stop}`, this.identity(attempt));
        attempt.terminal = true;
      }
    })();
    return attempt.cancelPromise;
  }

  private usage(attempt: Attempt, suffix: string, raw: unknown, queries: number): void {
    if (attempt.stop) return;
    const usage = tokenUsage(raw, this.prices);
    if (!usage && !queries) return;
    this.emit(attempt, suffix, 'llm.usage', {
      callId: attempt.effect.callId,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      queries,
      audioSeconds: 0,
      costUsd: (usage?.costUsd ?? 0) + queries * 0.0025,
    });
  }

  private async run(attempt: Attempt): Promise<void> {
    try {
      const initial = await this.start(attempt);
      attempt.providerId = initial.id;
      this.onStage?.('responseId');
      if (attempt.stop) {
        await this.cancel(attempt);
        return;
      }
      this.emit(attempt, 'started', 'job.started', this.identity(attempt));
      const response = await this.poll(attempt, initial as unknown as Record<string, unknown>);
      if (attempt.stop) return;
      await this.completeResearch(attempt, response);
    } catch (error) {
      if (attempt.stop) {
        if (attempt.providerId) await this.cancel(attempt);
        else {
          this.emit(attempt, attempt.stop, `job.${attempt.stop}`, this.identity(attempt));
          attempt.terminal = true;
        }
      } else {
        this.fail(attempt, error);
      }
    } finally {
      clearTimeout(attempt.timer);
      if (attempt.cancelPromise) await attempt.cancelPromise;
      this.active.delete(attempt.effect.callId);
    }
  }

  private async completeResearch(attempt: Attempt, response: Record<string, unknown>): Promise<void> {
    this.onStage?.('searchDone');
    const { evidence, queryCount, answer } = extractEvidence(response, attempt.context.state.config);
    this.usage(attempt, 'search:usage', response.usage, queryCount);
    attempt.searchMetered = true;
    const query = this.lookup(attempt.context.state, attempt.effect.jobId)?.publicQuery ?? '';
    const fetched = await fetchSearchPages(response, query, attempt.controller.signal, this.pageIo);
    if (Date.now() >= attempt.deadline) this.stop(attempt, 'timedOut');
    if (attempt.stop) return;
    fetched.stats.inputChars = `UNTRUSTED_SOURCE_DATA_JSON_BEGIN
${JSON.stringify({
      answer, results: evidence.results, pages: fetched.pages,
    })}
UNTRUSTED_SOURCE_DATA_JSON_END`.length;
    this.onStage?.('pagesFetched', fetched.stats);
    const output = await this.structure(attempt, answer, evidence.results, fetched.pages);
    if (Date.now() >= attempt.deadline) this.stop(attempt, 'timedOut');
    if (attempt.stop) return;
    this.onStage?.('structureDone');
    fetched.stats.claims = output.claims.length;
    appendExcerpts(output, evidence, fetched.texts, attempt.context.state.config, fetched.stats);
    if (Date.now() >= attempt.deadline) this.stop(attempt, 'timedOut');
    if (attempt.stop) return;
    this.emit(attempt, 'completed', 'job.completed', {
      ...this.identity(attempt),
      investigatorOutput: output,
      retrievalEvidence: evidence,
    });
    attempt.terminal = true;
  }

  private start(attempt: Attempt) {
    const job = this.lookup(attempt.context.state, attempt.effect.jobId);
    if (!job) throw new Error('missing_job');
    return this.client.responses.create({
      model: 'muse-spark-1.3',
      background: true,
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      max_tool_calls: 3,
      include: ['web_search_call.results'],
      reasoning: { effort: 'medium' },
      instructions: INVESTIGATOR_SEARCH_V1,
      input: job.publicQuery,
      // §8.4: the search step has its own cap; live runs used about 1,600 output tokens (Nov 1).
      max_output_tokens: attempt.context.state.config.investigatorSearchMaxOutputTokens,
    }, { signal: attempt.startController.signal });
  }

  private fail(attempt: Attempt, error: unknown): void {
    const status = object(error)?.status;
    const transient = typeof status === 'number' && (status === 429 || status >= 500);
    this.emit(attempt, 'failed', 'job.failed', {
      ...this.identity(attempt),
      reason: transient ? 'transient_provider_failure' : 'permanent_provider_failure',
    });
    attempt.terminal = true;
  }

  private async poll(attempt: Attempt, initial: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response = initial;
    let delay = 250;
    while (response.status === 'queued' || response.status === 'in_progress') {
      await new Promise<void>((resolve, reject) => {
        if (attempt.controller.signal.aborted) return reject(new Error('aborted'));
        const signal = attempt.controller.signal;
        const abort = () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, delay);
        signal.addEventListener('abort', abort, { once: true });
      });
      // The search results must be requested on retrieval too, not only at creation.
      response = await this.client.responses.retrieve(
        attempt.providerId!,
        { include: ['web_search_call.results'] },
        { signal: attempt.controller.signal },
      ) as unknown as Record<string, unknown>;
      delay = Math.min(delay * 2, 2000);
    }
    if (response.status !== 'completed') throw new Error('provider_failed');
    return response;
  }

  private async structure(
    attempt: Attempt, answer: string, results: unknown, pages: StructurePage[],
  ): Promise<InvestigatorOutput> {
    const response = await this.client.responses.create({
      model: 'muse-spark-1.3',
      stream: true,
      store: false,
      reasoning: { effort: 'minimal' },
      max_output_tokens: attempt.context.state.config.investigatorStructureMaxOutputTokens,
      instructions: INVESTIGATOR_STRUCTURE_V2,
      input: [
        'UNTRUSTED_SOURCE_DATA_JSON_BEGIN',
        JSON.stringify({ answer, results, pages }),
        'UNTRUSTED_SOURCE_DATA_JSON_END',
      ].join('\n'),
      text: {
        format: {
          type: 'json_schema',
          name: 'investigator_output',
          strict: true,
          schema: investigatorJsonSchema,
        },
      },
    }, { signal: attempt.controller.signal }).asResponse();
    let text = '';
    for await (const event of readEvents(response, attempt.controller.signal)) {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
      if (event.type === 'response.completed') {
        this.usage(attempt, 'structure:usage', object(event.response)?.usage ?? event.usage, 0);
        return InvestigatorOutputSchema.parse(normalizeInvestigatorWire(JSON.parse(text)));
      }
      if (['response.failed', 'response.incomplete', 'response.cancelled', 'error'].includes(event.type)) {
        throw new Error('structure_failed');
      }
    }
    throw new Error('missing_terminal');
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const attempt of this.active.values()) this.stop(attempt, 'cancelled');
    await Promise.all(this.pending);
  }
}
