// Manual only: npx tsx --env-file=.env scripts/investigator-smoke.ts
// Uses a fixed public query; do not run without explicit authorization and a Meta key.
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { MetaInvestigator } from '../src/model/meta/investigator.js';
import type { PageFetchStats } from '../src/model/meta/page-evidence.js';
import type { RawEvent } from '../src/runtime/model-port.js';
import type { InvestigatorOutput, RetrievalEvidence } from '../src/contract/index.js';
import { completedEvidenceStats } from './investigator-smoke-stats.js';

async function main(): Promise<void> {
  const meta = modelConfiguration({ ...process.env, SIDETHOUGHT_MODEL: 'meta' }).meta!;
  const started = Date.now();
  const timings: Record<string, number> = {};
  let pageStats: PageFetchStats | undefined;
  const model = new MetaInvestigator(
    meta.createClient(),
    meta.prices,
    () => ({ publicQuery: 'What are the public HTTP caching directives in RFC 9111?' }),
    (stage, stats) => {
      timings[stage] = Date.now() - started;
      if (stats) pageStats = stats;
    },
  );
  const state = initialState('smoke', loadConfig());
  let cost = 0;
  let queries = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const emit = (event: RawEvent) => {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'llm.usage') {
      cost += Number(payload.costUsd);
      queries += Number(payload.queries);
    }
    if (event.type === 'job.completed') {
      const evidence = payload.retrievalEvidence as RetrievalEvidence;
      const output = payload.investigatorOutput as InvestigatorOutput;
      console.log(JSON.stringify({
        elapsedMs: Date.now() - started,
        startToResponseIdMs: timings.responseId,
        startToSearchDoneMs: timings.searchDone,
        startToStructureDoneMs: timings.structureDone,
        startToPagesFetchedMs: timings.pagesFetched,
        pagesFetched: pageStats?.pagesFetched,
        pagesBlocked: pageStats?.pagesBlocked,
        pagesFailed: pageStats?.pagesFailed,
        ...completedEvidenceStats(evidence, output),
        claimsWithQuoteOnPage: pageStats?.claimsWithQuoteOnPage,
        claims: pageStats?.claims,
        pagesGivenToStructure: pageStats?.pagesGivenToStructure,
        inputChars: pageStats?.inputChars,
        queryCount: queries,
        costUsd: cost,
      }));
      finish();
    }
    if (event.type === 'job.failed' || event.type === 'job.timedOut' || event.type === 'job.cancelled') {
      console.error(`Investigator smoke ended: ${event.type}`);
      process.exitCode = 1;
      finish();
    }
  };
  model.handle({ type: 'job.dispatch', jobId: 'smoke-job', callId: 'smoke-call', capturedInputs: [] }, {
    state,
    emit,
  });
  await done;
  await model.shutdown();
}

main().catch(() => {
  console.error('Investigator smoke could not start: MODEL_API_KEY and Meta configuration are required.');
  process.exitCode = 1;
});
