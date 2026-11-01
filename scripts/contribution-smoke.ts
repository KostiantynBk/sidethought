// Manual only: npx tsx --env-file=.env scripts/contribution-smoke.ts
// Makes live paid calls; never run without explicit authorization.
import { syntheticState } from './contribution-smoke-state.js';
import { modelConfiguration, type MetaConnection } from '../src/model/meta/config.js';
import { MetaModel } from '../src/model/meta/executor.js';

type Role = 'deliberator' | 'checker';

async function call(role: Role, meta: MetaConnection): Promise<void> {
  const { state, effect } = syntheticState(role);
  let nominationCount: number | null = null;
  let applies: boolean | null = null;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const model = new MetaModel(meta.createClient(), meta.prices, {
    onMetric: metric => {
      console.log(JSON.stringify({
        role,
        firstDeltaMs: metric.firstDeltaMs ?? null,
        terminalMs: metric.terminalMs ?? null,
        schemaValid: metric.schemaValid ?? null,
        nominationCount,
        applies,
        costUsd: metric.usage?.costUsd ?? null,
        outcome: metric.outcome ?? null,
      }));
      if (metric.outcome !== 'completed' || !metric.schemaValid) process.exitCode = 1;
      finish();
    },
  });
  const ctx = {
    state,
    emit: (event: { type: string; payload: unknown }) => {
      const payload = event.payload as { output?: { nominations?: unknown[]; applies?: boolean } };
      if (event.type === 'deliberation.ready') nominationCount = payload.output?.nominations?.length ?? null;
      if (event.type === 'check.ready') applies = payload.output?.applies ?? null;
    },
  };
  const timeout = setTimeout(() => model.handle({ type: 'llm.abort', callId: effect.callId }, ctx), 30_000);
  try {
    model.handle(effect, ctx);
    await done;
  } finally {
    clearTimeout(timeout);
    await model.shutdown();
  }
}

async function smoke(): Promise<void> {
  const config = modelConfiguration({ ...process.env, SIDETHOUGHT_MODEL: 'meta' });
  await call('deliberator', config.meta!);
  await call('checker', config.meta!);
}

smoke().catch(() => {
  console.error('Contribution smoke could not start; check the Meta configuration.');
  process.exitCode = 1;
});
