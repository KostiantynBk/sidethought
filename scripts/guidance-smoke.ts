// Manual, paid, bounded synthetic check. No access to the user's database.
// npx tsx --env-file=.env scripts/guidance-smoke.ts
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import { assembleContext, type CallEffect } from '../src/context/index.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { MetaModel, type CallMetric } from '../src/model/meta/executor.js';

const cases = [
  {
    name: 'lost',
    input: 'I am lost. I have never worked on missing values. '
      + 'Explain with a tiny example and lead me through one step.',
  },
  {
    name: 'code',
    input: 'Show actual Python code using SimpleImputer with median on two numeric columns. Do not just offer code.',
  },
];

async function sample(example: (typeof cases)[number]): Promise<void> {
  const meta = modelConfiguration({ ...process.env, SIDETHOUGHT_MODEL: 'meta' }).meta!;
  const state = initialState('guidance', loadConfig());
  state.domain.inputs.push({ id: 'input', text: example.input, status: 'interpreted' });
  state.domain.reply = {
    requestId: 'request',
    callId: `call-${example.name}`,
    attempt: 1,
    inputIds: ['input'],
    basisRev: 0,
    capturedInputs: [],
    deliveryId: 'delivery',
    overridesSnapshotInputIds: [],
    buffer: '',
    status: 'streaming',
  };
  const effect: CallEffect = {
    type: 'llm.call',
    role: 'responder',
    requestId: 'request',
    callId: state.domain.reply.callId,
    basisRev: 0,
    capturedInputs: [],
  };
  let finish!: () => void;
  let text = '';
  const done = new Promise<void>(resolve => { finish = resolve; });
  const metric = (value: Readonly<CallMetric>) => {
    console.log(JSON.stringify({
      case: example.name,
      outcome: value.outcome,
      terminal: value.terminalType,
      firstTextMs: value.firstDeltaMs,
      elapsedMs: value.terminalMs,
      outputTokens: value.usage?.outputTokens,
      reasoningTokens: value.usage?.reasoningTokens,
      costUsd: value.usage?.costUsd,
      text,
    }));
    if (value.outcome !== 'completed') process.exitCode = 1;
    finish();
  };
  const model = new MetaModel(meta.createClient(), meta.prices, { assemble: assembleContext, onMetric: metric });
  const ctx = {
    state,
    emit: (event: { type: string; payload: unknown }) => {
      if (event.type === 'reply.chunk') text += (event.payload as { text: string }).text;
    },
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

async function main(): Promise<void> {
  for (const example of cases) await sample(example);
}

main().catch(() => {
  console.error('Guidance smoke failed; details suppressed to protect credentials.');
  process.exitCode = 1;
});
