import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { modelConfiguration } from '../src/model/meta/config.js';
import { tokenUsage } from '../src/model/meta/usage.js';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';
import { sentinel } from './t09-helpers.js';

const serverEnv = {
  SIDETHOUGHT_PASSCODE: 'synthetic-passcode',
  SIDETHOUGHT_COOKIE_SECRET: 'synthetic-cookie-secret-long-enough',
  SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  SIDETHOUGHT_DB_PATH: ':memory:',
};
beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('network prohibited'); }));
afterEach(() => vi.unstubAllGlobals());

describe('Meta configuration and policy inventory', () => {
  it('retains dev as the default without an API key', async () => {
    const config = serverConfig(serverEnv);
    const runtime = await createRuntime(config);
    try {
      const health = await runtime.app.inject({ method: 'GET', url: '/health' });
      expect(health.json()).toEqual({ ok: true, model: 'dev' });
    } finally {
      await runtime.close();
    }
  });

  it('selects Meta with a key without exposing it in the server config representation', () => {
    const config = serverConfig({ ...serverEnv, MODEL_API_KEY: sentinel });
    expect(config.model).toBe('meta');
    expect(config.meta).toBeDefined();
    expect(JSON.stringify(config)).not.toContain(sentinel);
  });

  it('allows explicit dev mode even when a key is present', () => {
    const config = serverConfig({ ...serverEnv, MODEL_API_KEY: sentinel, SIDETHOUGHT_MODEL: 'dev' });
    expect(config.model).toBe('dev');
    expect(config.meta).toBeUndefined();
  });

  it('fails missing-key Meta startup with a value-free message', () => {
    expect(() => serverConfig({ ...serverEnv, SIDETHOUGHT_MODEL: 'meta' }))
      .toThrow('MODEL_API_KEY is required for meta');
  });

  it('does not echo invalid model selection values', () => {
    expect(() => modelConfiguration({ SIDETHOUGHT_MODEL: sentinel })).toThrow('invalid SIDETHOUGHT_MODEL');
  });

  it('rejects credential-bearing base URLs without echoing the URL', () => {
    expect(() => modelConfiguration({ MODEL_API_KEY: sentinel, META_API_BASE_URL: `https://${sentinel}@example.com` }))
      .toThrow('invalid META_API_BASE_URL');
  });

  it('rejects invalid pricing with a variable-only message', () => {
    expect(() => modelConfiguration({ MODEL_API_KEY: sentinel, META_INPUT_USD_PER_MILLION: sentinel }))
      .toThrow('invalid META_INPUT_USD_PER_MILLION');
  });

  it('uses the existing output-cap inventory and architecture list prices', () => {
    const config = loadConfig();
    expect(config.interpreterMaxOutputTokens).toBe(1200);
    expect(config.responderMaxOutputTokens).toBe(800);
    expect(Math.ceil(config.interpreterMaxOutputTokens * config.structuredRetryTokenMultiplier)).toBe(1800);
    expect(modelConfiguration({ MODEL_API_KEY: sentinel }).meta?.prices).toEqual({
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.15,
      outputPerMillion: 4.25,
    });
  });

  it('uses configured unit prices instead of hard-coded event costs', () => {
    const prices = modelConfiguration({
      MODEL_API_KEY: sentinel,
      META_INPUT_USD_PER_MILLION: '2',
      META_CACHED_INPUT_USD_PER_MILLION: '1',
      META_OUTPUT_USD_PER_MILLION: '3',
    }).meta!.prices;
    expect(tokenUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, prices)?.costUsd).toBe(5);
  });

  it('does not invent usage when a terminal event omits usage', () => {
    const prices = modelConfiguration({ MODEL_API_KEY: sentinel }).meta!.prices;
    expect(tokenUsage(undefined, prices)).toBeUndefined();
  });

  it('rejects impossible usage rather than emitting a negative cost', () => {
    const prices = modelConfiguration({ MODEL_API_KEY: sentinel }).meta!.prices;
    expect(tokenUsage({
      input_tokens: 10,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 11 },
    }, prices)).toBeUndefined();
  });
});
