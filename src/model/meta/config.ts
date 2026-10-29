import OpenAI from 'openai';

export type MetaPrices = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};
export type MetaConnection = {
  createClient: (fetch?: typeof globalThis.fetch) => OpenAI;
  prices: MetaPrices;
};

function price(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim() ? Number(env[name]) : fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function baseUrl(value: string | undefined): string {
  try {
    const url = new URL(value || 'https://api.meta.ai/v1');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('invalid META_API_BASE_URL');
  }
}

// The key stays in this server-only closure and goes only into the SDK constructor.
export function modelConfiguration(env: NodeJS.ProcessEnv = process.env): {
  model: 'dev' | 'meta';
  meta?: MetaConnection;
} {
  const key = env.MODEL_API_KEY;
  const model = env.SIDETHOUGHT_MODEL || (key ? 'meta' : 'dev');
  if (model === 'dev') return { model };
  if (model !== 'meta') throw new Error('invalid SIDETHOUGHT_MODEL');
  if (!key?.trim()) throw new Error('MODEL_API_KEY is required for meta');
  const baseURL = baseUrl(env.META_API_BASE_URL);
  const prices = {
    inputPerMillion: price(env, 'META_INPUT_USD_PER_MILLION', 1.25),
    cachedInputPerMillion: price(env, 'META_CACHED_INPUT_USD_PER_MILLION', 0.15),
    outputPerMillion: price(env, 'META_OUTPUT_USD_PER_MILLION', 4.25),
  };
  return {
    model,
    meta: {
      prices,
      createClient: fetch => new OpenAI({
        apiKey: key,
        baseURL,
        fetch,
        // §6.3: only the kernel can authorize another billed attempt.
        maxRetries: 0,
        logLevel: 'off',
      }),
    },
  };
}
