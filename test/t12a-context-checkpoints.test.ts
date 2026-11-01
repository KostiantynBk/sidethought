import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { assembleContext } from '../src/context/index.js';
import { ContributionHarness } from './t12a-helpers.js';

it('checks the Deliberator context against its fixture', () => {
  const expected = JSON.parse(readFileSync('fixtures/t12a/deliberator-context.json', 'utf8'));
  const h = new ContributionHarness('memory', {}, []);
  h.connect();
  h.statement('Use a local interface.');
  h.timer('deliberationDebounce');
  const call = h.state.domain.initiative.deliberation!;
  const result = assembleContext(h.state, { type: 'llm.call', role: 'deliberator', ...call });
  const input = JSON.parse(result.input);
  expect(result.instructions).toContain(expected.promptVersion);
  expect(input.task).toMatchObject({ role: expected.role, instruction: expected.instruction, causalDepth: expected.causalDepth });
  expect(input.projectSnapshot.items.map((item: { text: string }) => item.text)).toContain(expected.itemText);
  expect(input).toHaveProperty('researchState');
  expect(input).toHaveProperty('recentWindow');
  expect(input).toHaveProperty('contributions');
  h.store.close();
});

it('checks the Checker context against its evidence fixture', () => {
  const expected = JSON.parse(readFileSync('fixtures/t12a/checker-context.json', 'utf8'));
  const h = new ContributionHarness('memory');
  h.connect();
  h.request();
  h.passReply();
  h.at += 3000;
  h.complete();
  const candidate = Object.values(h.state.domain.initiative.candidates).find(c => c.state === 'checking')!;
  const result = assembleContext(h.state, { type: 'llm.call', role: 'checker', ...candidate.check! });
  const input = JSON.parse(result.input);
  expect(result.instructions).toContain(expected.promptVersion);
  expect(input.task.role).toBe(expected.role);
  expect(input.task.contract).toContain(expected.contractContains);
  expect(input.candidate.type).toBe(expected.payloadType);
  expect(input.candidate.claims[0].text).toBe(expected.claimText);
  expect(input.candidate.claims[0].support[0].quoteVerified).toBe(true);
  h.store.close();
});
