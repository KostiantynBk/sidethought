import { createHash } from 'node:crypto';
import type { Dep, Item } from '../../contract/index.js';
import type { Context, State } from '../state.js';

const stopwords = new Set(['a', 'an', 'the', 'is', 'are', 'do', 'does', 'of', 'to', 'please']);

export function terms(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[’‘]/gu, "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
}

export function questionKey(question: string, deps: Dep[]): string {
  const versions = [...deps].sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
  const normalized = terms(question).filter(term => !stopwords.has(term)).join(' ');
  return createHash('sha256').update(JSON.stringify([normalized, versions])).digest('hex');
}

// T08 will wire controls here; explicit requests do not use proactive scope scoring (§8.2).
export function researchControlBlock(_domain: State['domain']): string | undefined {
  return undefined;
}

export function queryPrivacyFailure(context: Pick<Context, 'config' | 'domain'>, query: string): string | undefined {
  if (!query.trim() || query.length > context.config.publicQueryMaxChars) return 'query_length';
  const queryTerms = new Set(terms(query));
  const privateTerms = Object.values(context.domain.items).filter(item => item.private)
    .flatMap(item => terms(item.text));
  const blocked = [...privateTerms, ...context.config.privateTermBlocklist.flatMap(terms)];
  // Intentionally conservative: even a common private term fails closed. Paraphrases remain a limitation.
  if (blocked.some(term => queryTerms.has(term))) return 'private_term';
  return undefined;
}

export function dependencyState(deps: readonly Dep[], items: Record<string, Item>): {
  removed?: string;
  edited: string[];
} {
  const edited: string[] = [];
  for (const dep of deps) {
    const item = items[dep.itemId];
    if (!item) return {
      removed: 'deleted',
      edited,
    };
    if (['superseded', 'retracted', 'rejected'].includes(item.status)) {
      return {
        removed: item.status,
        edited,
      };
    }
    if (item.contentVersion !== dep.contentVersion) edited.push(dep.itemId);
  }
  return { edited };
}
