// Manual, paid, bounded synthetic check. Does not open the user's database.
// npx tsx --env-file=.env scripts/memory-smoke.ts
import { loadConfig } from '../src/config/index.js';
import type { CallEffect } from '../src/context/index.js';
import { initialState } from '../src/kernel/index.js';
import { assembleWithLessons } from '../src/memory/context.js';
import type { ProjectMemoryStore } from '../src/memory/store.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { MetaModel, type CallMetric } from '../src/model/meta/executor.js';
import { REDUCER_VERSION } from '../src/runtime/session-runner.js';
import { SqliteStore } from '../src/store/sqlite.js';

function seed(store: SqliteStore, memory: ProjectMemoryStore) {
  const source = memory.createProject('Amber Finch');
  const target = memory.createProject('Demand Forecast');
  const state = initialState(source.id, loadConfig());
  const quote = 'The amber-canary pilot took 43 minutes on this laptop. Start with a small forecasting run '
    + 'instead of a broad parameter sweep on this same laptop.';
  const inputId = `${source.id}.1.1`;
  state.domain.inputs.push({ id: inputId, text: quote, status: 'interpreted' });
  store.commit(source.id, [], { seq: 0, reducerVersion: REDUCER_VERSION, state });
  memory.createLesson(source.id, {
    sourceInputId: inputId,
    quote,
    text: 'The amber-canary pilot took 43 minutes on this laptop; prefer a small first run before a broad sweep.',
    terms: ['forecasting'],
    confirmed: true,
  });
  return target.id;
}

async function sample(memory: ProjectMemoryStore, projectId: string, name: string, text: string, index: number) {
  const meta = modelConfiguration({ ...process.env, SIDETHOUGHT_MODEL: 'meta' }).meta!;
  const state = initialState(projectId, loadConfig());
  state.domain.inputs.push({ id: `${projectId}.1.1`, text, status: 'interpreted' });
  const callId = `${projectId}.${index + 3}.2`;
  const requestId = `${projectId}.${index + 3}.1`;
  state.domain.reply = {
    requestId,
    callId,
    attempt: 1,
    inputIds: [`${projectId}.1.1`],
    basisRev: 0,
    capturedInputs: [],
    deliveryId: `${projectId}.${index + 3}.3`,
    overridesSnapshotInputIds: [],
    buffer: '',
    status: 'streaming',
  };
  const effect: CallEffect = {
    type: 'llm.call',
    role: 'responder',
    requestId,
    callId,
    basisRev: 0,
    capturedInputs: [],
  };
  let finish!: () => void;
  let output = '';
  let suppliedLessons = 0;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const metric = (value: Readonly<CallMetric>) => {
    console.log(JSON.stringify({
      case: name,
      outcome: value.outcome,
      suppliedLessons,
      firstTextMs: value.firstDeltaMs,
      elapsedMs: value.terminalMs,
      costUsd: value.usage?.costUsd,
      text: output,
    }));
    if (value.outcome !== 'completed') process.exitCode = 1;
    finish();
  };
  const model = new MetaModel(meta.createClient(), meta.prices, {
    assemble: (snapshot, dispatch) => {
      const prompt = assembleWithLessons(memory, snapshot, dispatch);
      suppliedLessons = JSON.parse(prompt.input).reusableLessons?.length ?? 0;
      return prompt;
    },
    onMetric: metric,
  });
  const ctx = {
    state,
    emit: (event: { type: string; payload: unknown }) => {
      if (event.type === 'reply.chunk') output += (event.payload as { text: string }).text;
    },
  };
  const timeout = setTimeout(() => model.handle({ type: 'llm.abort', callId }, ctx), 25_000);
  try {
    model.handle(effect, ctx);
    await done;
  } finally {
    clearTimeout(timeout);
    await model.shutdown();
  }
}

async function main() {
  const store = new SqliteStore(':memory:');
  const memory = store.projectMemory();
  try {
    const target = seed(store, memory);
    const query = "I'm starting a forecasting model on this laptop. My instinct is a broad parameter sweep. "
      + 'How should we begin?';
    await sample(memory, target, 'memory-off', query, 0);
    memory.setEnabled(target, true);
    await sample(memory, target, 'memory-on', query, 1);
    await sample(memory, target, 'irrelevant-control', 'Help me choose colors for a photo gallery.', 2);
  } finally {
    store.close();
  }
}
main().catch(() => {
  console.error('Memory smoke failed; diagnostics suppressed to protect credentials.');
  process.exitCode = 1;
});
