import { expect, it } from 'vitest';
import { syntheticState } from '../scripts/contribution-smoke-state.js';
import { assembleContext } from '../src/context/index.js';

it('assembles the real Deliberator context for the synthetic smoke state', () => {
  const { state, effect } = syntheticState('deliberator');
  const prompt = assembleContext(state, effect);
  expect(prompt.instructions).toContain('deliberator-v1');
  expect(JSON.parse(prompt.input).task.role).toBe('deliberator');
});

it('assembles the real Checker context for the synthetic smoke candidate', () => {
  const { state, effect } = syntheticState('checker');
  const prompt = assembleContext(state, effect);
  const input = JSON.parse(prompt.input);
  expect(prompt.instructions).toContain('checker-v1');
  expect(input.candidate.type).toBe('inference');
  expect(input.candidate.text).toBe('Keep notes on the phone.');
  expect(input.candidate.citedItems).toHaveLength(1);
});
