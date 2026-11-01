import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { DeliberatorOutputSchema } from '../src/contract/roles.js';
import { initialState } from '../src/kernel/index.js';
import { DevModel } from '../src/runtime/dev-model.js';
import type { RawEvent } from '../src/runtime/model-port.js';

it('nominates one deterministic insight from matching captured items', async () => {
  const state = initialState('synthetic', loadConfig());
  for (const [id, text] of [['one', 'Keep offline notes.'], ['two', 'Recover offline notes.']]) {
    state.domain.items[id!] = {
      id: id!,
      kind: 'requirement',
      status: 'stated',
      text: text!,
      contentVersion: 1,
      private: false,
      provenance: { origin: 'user', quoteSpans: [] },
      voiceConfirmNeeded: false,
    };
  }
  const model = new DevModel();
  const events: RawEvent[] = [];
  const effect = {
    type: 'llm.call' as const,
    role: 'deliberator' as const,
    requestId: 'request',
    callId: 'call',
    basisRev: 0,
    capturedInputs: [{ itemId: 'one', contentVersion: 1 }, { itemId: 'two', contentVersion: 1 }],
  };
  model.handle(effect, { state, emit: event => { events.push(event); } });
  const payload = events[0]!.payload as { output: unknown };
  const result = DeliberatorOutputSchema.parse(payload.output);
  expect(result.nominations).toHaveLength(1);
  expect(result.nominations[0]?.scores.consequence).toBe(2);
  expect(result.nominations[0]?.depItemIds).toEqual(['one', 'two']);
  await model.shutdown();
});
