import type { MetaPrices } from './config.js';
import { object } from './stream.js';

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
};

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function tokenUsage(raw: unknown, prices: MetaPrices): TokenUsage | undefined {
  const usage = object(raw);
  if (!usage) return;
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return;
  const cachedInputTokens = count(object(usage.input_tokens_details)?.cached_tokens) ?? 0;
  const reasoningTokens = count(object(usage.output_tokens_details)?.reasoning_tokens) ?? 0;
  if (cachedInputTokens > inputTokens || reasoningTokens > outputTokens) return;
  // §9.3: reasoning is already included in output_tokens; do not charge it twice.
  const costUsd = ((inputTokens - cachedInputTokens) * prices.inputPerMillion
    + cachedInputTokens * prices.cachedInputPerMillion + outputTokens * prices.outputPerMillion) / 1_000_000;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    costUsd,
  };
}
