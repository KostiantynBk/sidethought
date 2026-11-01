import { afterEach, expect, it } from 'vitest';
import { EventSchema } from '../src/contract/index.js';
import { invariantRegistry } from '../src/harness/invariants.js';
import { I11, promised_closed_once } from '../src/harness/research-invariants.js';
import { ResearchHarness } from './t11a-helpers.js';

let h: ResearchHarness;
afterEach(() => h?.store.close());
const event = EventSchema.parse({
  eventId: 'invariant-probe',
  sessionId: 's',
  acceptedAt: 100,
  type: 'client.disconnected',
  payload: {},
});

it('registers admission limits and promise closure as separate invariants', () => {
  expect(invariantRegistry).toContain(I11);
  expect(invariantRegistry).toContain(promised_closed_once);
  expect(I11).not.toBe(promised_closed_once);
});

it('detects an injected concurrency violation through I11', () => {
  h = new ResearchHarness('memory');
  h.request(['One?', 'Two?', 'Three?']);
  const before = h.state;
  const after = structuredClone(before);
  Object.values(after.domain.jobs)[2]!.state = 'running';
  expect(I11(before, event, after, [], [])).toContain('I11 concurrency exceeded');
});

it('detects an extra promised closure rather than trusting a terminal job', () => {
  h = new ResearchHarness('memory');
  h.request();
  h.complete();
  const before = h.state;
  const after = structuredClone(before);
  const job = Object.values(after.domain.jobs)[0]!;
  job.closureCount = 2;
  expect(promised_closed_once(before, event, after, [], [])).toContain(`promised_closed_once: ${job.id}`);
});
