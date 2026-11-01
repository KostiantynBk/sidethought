// Manual, paid, bounded synthetic check of the REAL prompt and kernel patch application.
// Unlike spark-smoke.ts, this does not substitute a trivial instruction for the role prompt.
// npx tsx --env-file=.env scripts/interpreter-smoke.ts
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/index.js';
import { MetaModel } from '../src/model/meta/executor.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { SessionRunner } from '../src/runtime/session-runner.js';
import { SqliteStore } from '../src/store/sqlite.js';

const cases = [
  { name: 'requirement', text: 'Notes must stay on the phone. No cloud storage.' },
  { name: 'experience', text: 'My amber-canary pilot took 43 minutes on this laptop. '
    + 'For forecasting, I prefer a small first run before a broad parameter sweep.' },
  { name: 'question', text: 'Should I use linear regression or a random forest for this project?' },
];

async function sample(example: (typeof cases)[number]): Promise<void> {
  const meta = modelConfiguration({ ...process.env, SIDETHOUGHT_MODEL: 'meta' }).meta!;
  const store = new SqliteStore(':memory:');
  const model = new MetaModel(meta.createClient(), meta.prices);
  let runner: SessionRunner;
  runner = new SessionRunner('synthetic', loadConfig(), store, Date.now, effects => {
    for (const effect of effects) {
      // No timers fired: only interpretation runs, never a foreground Responder request.
      if (effect.type === 'llm.call' && effect.role === 'interpreter') model.handle(effect, {
        state: runner.current(),
        emit: event => { runner.accept(event); },
      });
    }
  });
  try {
    runner.accept({
      eventId: randomUUID(),
      sessionId: 'synthetic',
      type: 'input.committed',
      payload: { clientMsgId: randomUUID(), text: example.text, modality: 'text' },
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = runner.current().domain.inputs[0]?.status;
      if (status === 'interpreted' || status === 'needs_retry') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await model.shutdown();
    const state = runner.current();
    const metrics = [...model.metrics.values()].map(metric => ({
      outcome: metric.outcome,
      schemaValid: metric.schemaValid,
      elapsedMs: metric.terminalMs,
      outputTokens: metric.usage?.outputTokens,
      reasoningTokens: metric.usage?.reasoningTokens,
      costUsd: metric.usage?.costUsd,
    }));
    const items = Object.values(state.domain.items).map(item => ({ kind: item.kind, status: item.status,
      text: item.text, quoteCount: item.provenance.quoteSpans.length }));
    const status = state.domain.inputs[0]?.status;
    console.log(JSON.stringify({ case: example.name, status, inputKind: state.domain.inputs[0]?.kind, items, metrics }));
    if (status !== 'interpreted') process.exitCode = 1;
    if (example.name === 'requirement' && !items.some(item => item.kind === 'requirement')) process.exitCode = 1;
    if (example.name === 'question' && items.some(item => item.status === 'stated')) process.exitCode = 1;
  } finally {
    await model.shutdown();
    store.close();
  }
}
async function main() {
  for (const example of cases) await sample(example);
}
main().catch(() => {
  console.error('Interpreter smoke failed; diagnostics suppressed to protect credentials.');
  process.exitCode = 1;
});
