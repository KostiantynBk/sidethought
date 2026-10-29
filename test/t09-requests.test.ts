import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { InterpreterOutputSchema } from '../src/contract/roles.js';
import { interpreterJsonSchema, normalizeInterpreterWire } from '../src/model/meta/schema.js';
import { object } from '../src/model/meta/stream.js';
import { delta, finished, run, setup, terminal, validOutput } from './t09-helpers.js';

beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('network prohibited'); }));
afterEach(() => vi.unstubAllGlobals());

function inspectSchema(value: unknown): number {
  const schema = object(value);
  if (!schema) return 0;
  expect(schema).not.toHaveProperty('$ref');
  expect(schema).not.toHaveProperty('oneOf');
  expect(schema).not.toHaveProperty('allOf');
  const properties = object(schema.properties);
  if (properties) {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(properties));
  }
  const children = [
    ...Object.values(properties ?? {}),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(schema.items ? [schema.items] : []),
  ];
  const ownDepth = schema.type === 'object' || schema.type === 'array' ? 1 : 0;
  return ownDepth + Math.max(0, ...children.map(inspectSchema));
}

describe('Meta request and schema contracts', () => {
  it('sends the exact Interpreter request shape and explicit Meta endpoint', async () => {
    const test = await run('interpreter', [delta(JSON.stringify(validOutput)), terminal()]);
    const body = JSON.parse(String(test.requests[0]?.body));
    expect(body).toEqual({
      model: 'muse-spark-1.3',
      stream: true,
      store: false,
      reasoning: { effort: 'low' },
      max_output_tokens: 1200,
      instructions: 'synthetic instructions',
      input: 'synthetic input',
      text: {
        format: {
          type: 'json_schema',
          name: 'interpreter_output',
          strict: true,
          schema: interpreterJsonSchema,
        },
      },
    });
    expect(test.fetch).toHaveBeenCalledWith('https://api.meta.ai/v1/responses', expect.any(Object));
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body).not.toHaveProperty('response_format');
  });

  it('sends plain Responder text without a JSON format or history identifier', async () => {
    const test = await run('responder', [delta('Hello.'), terminal()]);
    expect(JSON.parse(String(test.requests[0]?.body))).toEqual({
      model: 'muse-spark-1.3',
      stream: true,
      store: false,
      reasoning: { effort: 'low' },
      max_output_tokens: 800,
      instructions: 'synthetic instructions',
      input: 'synthetic input',
    });
  });

  it('uses the configured higher cap for a kernel-issued Interpreter retry', async () => {
    const test = setup('interpreter', [delta(JSON.stringify(validOutput)), terminal()]);
    test.ctx.state.config = loadConfig({ interpreterMaxOutputTokens: 1400, structuredRetryTokenMultiplier: 2 });
    test.ctx.state.domain.call!.attempt = 2;
    test.model.handle(test.effect, test.ctx);
    await finished(test.model);
    expect(JSON.parse(String(test.requests[0]?.body)).max_output_tokens).toBe(2800);
    expect(test.fetch).toHaveBeenCalledTimes(1);
    await test.model.shutdown();
  });

  it('generates a strict schema with no references or recursion and nesting depth at most ten', () => {
    expect(inspectSchema(interpreterJsonSchema)).toBeLessThanOrEqual(10);
    expect(interpreterJsonSchema.type).toBe('object');
    expect(interpreterJsonSchema).not.toHaveProperty('anyOf');
    expect(JSON.stringify(interpreterJsonSchema)).not.toContain('"$ref"');
  });

  it('normalizes nullable optionals from strict wire output without altering the internal contract', async () => {
    const output = {
      ...validOutput,
      clarification: null,
      agreesWith: null,
      ops: [{
        op: 'create',
        localRef: null,
        kind: 'requirement',
        status: 'proposed',
        text: 'Synthetic idea',
        quoteSpans: [],
      }],
    };
    const { emitted } = await run('interpreter', [delta(JSON.stringify(output)), terminal()]);
    expect(emitted.at(-1)?.type).toBe('interpretation.ready');
    const payload = emitted.at(-1)?.payload as { output: Record<string, unknown> };
    expect(payload.output).not.toHaveProperty('clarification');
    expect(payload.output).not.toHaveProperty('agreesWith');
    expect(InterpreterOutputSchema.safeParse(payload.output).success).toBe(true);
  });

  it('does not erase required nulls when normalizing the strict wire output', () => {
    const normalized = normalizeInterpreterWire({ ...validOutput, ops: null });
    expect(InterpreterOutputSchema.safeParse(normalized).success).toBe(false);
  });

  it('does not erase unknown null fields on another discriminated union branch', () => {
    const output = {
      ...validOutput,
      ops: [{ op: 'reject', itemId: 'item', quoteSpans: [], localRef: null }],
    };
    expect(InterpreterOutputSchema.safeParse(normalizeInterpreterWire(output)).success).toBe(false);
  });

  it('normalizes a supersede replacement localRef without dropping its required fields', () => {
    const output = {
      ...validOutput,
      ops: [{
        op: 'supersede',
        itemId: 'item',
        quoteSpans: [],
        replacement: {
          localRef: null,
          kind: 'requirement',
          status: 'proposed',
          text: 'New idea',
          quoteSpans: [],
        },
      }],
    };
    expect(InterpreterOutputSchema.safeParse(normalizeInterpreterWire(output)).success).toBe(true);
  });
});
