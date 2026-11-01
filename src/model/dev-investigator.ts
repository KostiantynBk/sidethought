import type { InvestigatorExecutor, JobContext, JobEffect, JobLookup } from './meta/investigator.js';

type Pending = { timer: ReturnType<typeof setTimeout>; context: JobContext; jobId: string };

export class DevInvestigator implements InvestigatorExecutor {
  private pending = new Map<string, Pending>();
  constructor(private lookup: JobLookup) {}

  handle(effect: JobEffect, context: JobContext): void {
    if (effect.type === 'job.abort') {
      const pending = this.pending.get(effect.callId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(effect.callId);
      this.emit(pending.context, effect.callId, 'cancelled', pending.jobId);
      return;
    }
    if (this.pending.has(effect.callId)) return;
    if (!this.lookup(context.state, effect.jobId)) {
      this.emit(context, effect.callId, 'failed', effect.jobId, { reason: 'permanent_missing_job' });
      return;
    }
    this.emit(context, effect.callId, 'started', effect.jobId);
    const timer = setTimeout(() => {
      this.pending.delete(effect.callId);
      this.emit(context, effect.callId, 'completed', effect.jobId, {
        investigatorOutput: {
          verdict: 'inconclusive',
          claims: [],
          caveats: ['Synthetic dev finding; no real research was performed.'],
        },
        retrievalEvidence: { completedSearchCalls: 0, issuedQueries: [], results: [] },
      });
    }, 150);
    this.pending.set(effect.callId, { timer, context, jobId: effect.jobId });
  }

  private emit(context: JobContext, callId: string, suffix: string, jobId: string, extra: object = {}): void {
    context.emit({
      eventId: `${callId}:${suffix}`,
      sessionId: context.state.sessionId,
      type: `job.${suffix}`,
      payload: { jobId, callId, ...extra },
    });
  }

  async shutdown(): Promise<void> {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }
}
