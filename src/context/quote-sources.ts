import type { State } from '../kernel/state.js';
import type { QuoteInput } from '../kernel/items/index.js';
import { deliveredText, recentTurns } from './recent.js';

export function deliveredQuoteInputs(domain: State['domain']): QuoteInput[] {
  return Object.values(domain.deliveries).flatMap(delivery => {
    const text = deliveredText(delivery);
    return text ? [{
      id: delivery.id,
      text,
      origin: 'assistant' as const,
      modality: 'text' as const,
    }] : [];
  });
}

// Capture the exact prompt window and quote text at dispatch, never at result time (decision 22).
export function captureQuoteWitness(domain: State['domain'], batch: string[], limit: number) {
  const recent = recentTurns(domain, limit);
  const recentIds = new Set(recent.map(turn => turn.id));
  const users: QuoteInput[] = domain.inputs
    .filter(input => (input.origin ?? 'user') === 'user' && (batch.includes(input.id) || recentIds.has(input.id)))
    .map(input => ({
      id: input.id,
      text: input.text,
      origin: 'user',
      modality: input.modality ?? 'text',
    }));
  return {
    recent,
    sources: [...users, ...deliveredQuoteInputs(domain).filter(input => recentIds.has(input.id))],
  };
}

export function allowedQuoteInputs(domain: State['domain'], batch: string[], limit: number): QuoteInput[] {
  const recent = new Set(recentTurns(domain, limit).map(turn => turn.id));
  const users: QuoteInput[] = domain.inputs
    .filter(input => (input.origin ?? 'user') === 'user'
      && (batch.includes(input.id) || (input.status === 'interpreted' && recent.has(input.id))))
    .map(input => ({
      id: input.id,
      text: input.text,
      origin: 'user',
      modality: input.modality ?? 'text',
    }));
  return [...users, ...deliveredQuoteInputs(domain).filter(input => recent.has(input.id))];
}
