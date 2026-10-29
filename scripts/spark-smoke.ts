// Manual only: npx tsx --env-file=.env scripts/spark-smoke.ts
// Never import this script from tests. It makes two real, bounded requests when explicitly run.
import { loadConfig } from '../src/config/index.js';
import { initialState, type State } from '../src/kernel/index.js';
import type { CallEffect } from '../src/context/index.js';
import { modelConfiguration, type MetaConnection } from '../src/model/meta/config.js';
import { MetaModel, type CallMetric } from '../src/model/meta/executor.js';

type Role = 'interpreter' | 'responder';

function printMetric(metric: Readonly<CallMetric>): void {
  console.log(JSON.stringify({
    role: metric.role,
    firstDeltaMs: metric.firstDeltaMs ?? null,
    terminalMs: metric.terminalMs ?? null,
    terminalType: metric.terminalType ?? null,
    outcome: metric.outcome,
    inputTokens: metric.usage?.inputTokens ?? null,
    cachedInputTokens: metric.usage?.cachedInputTokens ?? null,
    outputTokens: metric.usage?.outputTokens ?? null,
    reasoningTokens: metric.usage?.reasoningTokens ?? null,
    costUsd: metric.usage?.costUsd ?? null,
    interpreterSchemaValid: metric.schemaValid ?? null,
  }));
}

function syntheticPrompt(_state: State, effect: CallEffect) {
  return {
    instructions: effect.role === 'interpreter'
      ? 'Classify synthetic input smoke-input as a statement. Return empty arrays for all other arrays; '
        + 'use null for optional fields. Do not propose patches or research.'
      : 'Respond to the synthetic idea in one short plain sentence. No research or claims about facts.',
    input: 'Synthetic input smoke-input: I want to organize my own notes.',
  };
}

function syntheticCall(role: Role) {
  const state = initialState('smoke', loadConfig());
  const effect: CallEffect = {
    type: 'llm.call',
    role,
    requestId: `smoke-${role}`,
    callId: `smoke-${role}-1`,
    basisRev: 0,
    capturedInputs: [],
  };
  state.domain.call = {
    requestId: effect.requestId,
    callId: effect.callId,
    attempt: 1,
    inputIds: ['smoke-input'],
    basisRev: 0,
    capturedInputs: [],
    quoteWitness: {
      recent: [],
      sources: [],
    },
  };
  return { state, effect };
}

async function call(role: Role, meta: MetaConnection): Promise<void> {
  const { state, effect } = syntheticCall(role);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const model = new MetaModel(meta.createClient(), meta.prices, {
    assemble: syntheticPrompt,
    onMetric: metric => {
      printMetric(metric);
      if (metric.outcome !== 'completed') process.exitCode = 1;
      finish();
    },
  });
  const ctx = {
    state,
    emit: () => undefined,
  };
  const timeout = setTimeout(() => model.handle({ type: 'llm.abort', callId: effect.callId }, ctx), 25_000);
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
  await call('interpreter', config.meta!);
  await call('responder', config.meta!);
}

smoke().catch(() => {
  // Do not print SDK diagnostics, environment values, prompts or model output.
  console.error('Spark smoke could not start: MODEL_API_KEY must be set and Meta configuration must be valid.');
  process.exitCode = 1;
});
