import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { checkerJsonSchema, deliberatorJsonSchema } from '../src/model/meta/schema.js';
import { delta, finished, sentinel, setup, terminal } from './t09-helpers.js';

beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('network prohibited'); }));
afterEach(() => vi.unstubAllGlobals());

it('sends the Deliberator schema and its own configured budget', async () => {
  const test = setup('interpreter', [delta('{"nominations":[]}'), terminal()]);
  test.effect.role = 'deliberator';
  test.ctx.state.config = loadConfig({ deliberatorMaxOutputTokens: 3100 });
  test.model.handle(test.effect, test.ctx);
  await finished(test.model);
  const body = JSON.parse(String(test.requests[0]?.body));
  expect(body.reasoning).toEqual({ effort: 'medium' });
  expect(body.max_output_tokens).toBe(3100);
  expect(body.store).toBe(false);
  expect(body.text.format).toEqual({
    type: 'json_schema',
    name: 'deliberator_output',
    strict: true,
    schema: deliberatorJsonSchema,
  });
  expect(test.emitted.map(event => event.type)).toEqual(['llm.usage', 'deliberation.ready']);
  expect(JSON.stringify(test.emitted)).not.toContain(sentinel);
  await test.model.shutdown();
});

it('journals exactly the lessons included in the Deliberator request', async () => {
  const lessons = [{ lessonId: 'l1', version: 2, sourceProjectName: 'Memory A', text: 'A 43 minute pilot.' }];
  const input = JSON.stringify({ reusableLessons: lessons });
  const test = setup('interpreter', [delta('{"nominations":[]}'), terminal()], {
    assemble: () => ({ instructions: 'Synthetic', input, suppliedLessons: lessons }),
  });
  test.effect.role = 'deliberator';
  test.model.handle(test.effect, test.ctx);
  await finished(test.model);
  const body = JSON.parse(String(test.requests[0]?.body));
  expect(JSON.stringify(body)).toContain('43 minute pilot');
  expect(test.emitted.at(-1)?.payload).toMatchObject({ suppliedLessons: lessons });
  await test.model.shutdown();
});

it('sends the Checker schema and its own configured budget', async () => {
  const output = { applies: true, reason: 'current', utterance: 'Synthetic.', claimsUsed: [] };
  const test = setup('interpreter', [delta(JSON.stringify(output)), terminal()]);
  test.effect.role = 'checker';
  test.ctx.state.config = loadConfig({ checkerMaxOutputTokens: 700 });
  test.model.handle(test.effect, test.ctx);
  await finished(test.model);
  const body = JSON.parse(String(test.requests[0]?.body));
  expect(body.reasoning).toEqual({ effort: 'minimal' });
  expect(body.max_output_tokens).toBe(700);
  expect(body.store).toBe(false);
  expect(body.text.format).toEqual({
    type: 'json_schema',
    name: 'checker_output',
    strict: true,
    schema: checkerJsonSchema,
  });
  expect(test.emitted.map(event => event.type)).toEqual(['llm.usage', 'check.ready']);
  await test.model.shutdown();
});

it('reports invalid Deliberator output without leaking content', async () => {
  const test = setup('interpreter', [delta('{"nominations":"bad"}'), terminal()]);
  test.effect.role = 'deliberator';
  test.model.handle(test.effect, test.ctx);
  await finished(test.model);
  expect(test.emitted.at(-1)?.type).toBe('deliberation.failed');
  expect(JSON.stringify(test.emitted)).not.toContain('nominations');
  await test.model.shutdown();
});

it('reports invalid Checker output without leaking content', async () => {
  const test = setup('interpreter', [delta('{"applies":"bad"}'), terminal()]);
  test.effect.role = 'checker';
  test.model.handle(test.effect, test.ctx);
  await finished(test.model);
  expect(test.emitted.at(-1)?.type).toBe('check.failed');
  expect(JSON.stringify(test.emitted)).not.toContain('applies');
  await test.model.shutdown();
});
