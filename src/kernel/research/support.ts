import type { InvestigatorOutput, RetrievalEvidence } from '../../contract/index.js';
import { terms } from './policy.js';

type Support = InvestigatorOutput['claims'][number]['support'][number];
const sentenceWords = new Set([
  'a', 'an', 'the', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'they', 'you', 'your',
  'edits', 'editing', 'first', 'initial', 'setup', 'sign', 'only', 'on', 'in', 'at', 'after', 'before',
  'for', 'with', 'without', 'no', 'not', 'all', 'offline', 'online', 'requires', 'supports', 'works',
]);
const negations = new Set([
  'no', 'not', 'never', 'without', 'neither', 'nor', 'cannot', "can't", "doesn't", "don't", "isn't",
  "aren't", "won't", "wasn't", "weren't", "couldn't", "shouldn't", "wouldn't", "hasn't", "haven't",
  "hadn't", "mustn't", "needn't", "didn't", 'none', 'nobody', 'nothing', 'nowhere',
]);
const units = new Set([
  'ms', 's', 'sec', 'secs', 'second', 'seconds', 'min', 'mins', 'minute', 'minutes', 'hour', 'hours',
  'day', 'days', 'month', 'months', 'year', 'years', 'kb', 'mb', 'gb', 'tb', 'kib', 'mib', 'gib', 'tib',
  'hz', 'khz', 'mhz', 'ghz', 'usd', 'eur', 'gbp', 'percent', 'users', 'seats', 'requests', 'tokens',
]);
const numberWords = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
  'thousand', 'million', 'billion', 'trillion', 'half', 'quarter', 'first', 'second', 'third',
  'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
]);
const quantityGlue = new Set(['and', 'or', 'to', 'of', 'is', 'are', 'was', 'were', 'but', 'than']);

export function normalizeEvidence(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[’‘]/gu, "'")
    .replace(/[“”]/gu, '"').replace(/[‐‑‒–—―−]/gu, '-')
    .replace(/\s+/gu, ' ').trim();
}

function numbers(text: string): string[] {
  const normalized = normalizeEvidence(text);
  const numeric = normalized.match(/[-+]?[$€£]?\s*(?:\d+(?:[.,]\d+)*|[.,]\d+)(?:\s*%)?/gu) ?? [];
  return numeric.map(value => value.replace(/\s/gu, ''));
}

function quantities(text: string): string[] {
  // Keep the number WITH its adjacent unit: swapped units cannot pass as a bag of tokens.
  // Unknown adjacent words are treated as possible units, conservatively card-only on mismatch.
  const tokens = normalizeEvidence(text).match(
    /[-+]?[$€£]?(?:\d+(?:[.,]\d+)*|[.,]\d+)(?:\s*%)?|[\p{L}]+/gu,
  ) ?? [];
  return tokens.flatMap((token, index) => {
    if (!/\d/u.test(token) && !numberWords.has(token)) return [];
    const next = tokens[index + 1];
    const unit = next && !quantityGlue.has(next) ? next : '';
    return [`${token.replace(/\s/gu, '')}|${unit}`];
  });
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${terms(text).join(' ')} `.includes(` ${terms(phrase).join(' ')} `);
}

function names(text: string): string[] {
  const tokens = text.normalize('NFKC').match(/[\p{L}][\p{L}\p{N}-]*/gu) ?? [];
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokens[index]!;
    if (!/\p{Lu}/u.test(word) || sentenceWords.has(word.toLowerCase())) continue;
    const phrase = [word];
    // Keep labels and multiword names together, not merely somewhere in the same quote.
    while (tokens[index + 1] && /\p{Lu}/u.test(tokens[index + 1]!)) {
      phrase.push(tokens[++index]!);
    }
    result.push(phrase.join(' '));
  }
  return result;
}

function lowercaseSubject(claim: string): string | undefined {
  // Lowercase brands are ambiguous without a dictionary. Preserve a simple subject rather than
  // pretending capitalization catches every product; missing/ambiguous subjects stay card-only.
  const subject = normalizeEvidence(claim).match(
    /^(?:the\s+)?([\p{L}][\p{L}\p{N}-]*)\s+(?:works|functions|supports|requires|allows|costs|provides)\b/u,
  )?.[1];
  return subject && !sentenceWords.has(subject) ? subject : undefined;
}

export function consistentClaim(claim: string, quote: string): boolean {
  const quoteTerms = new Set(terms(quote));
  const quotedNumbers = new Set(numbers(quote));
  const quotedQuantities = new Set(quantities(quote));
  if (numbers(claim).some(number => !quotedNumbers.has(number))) return false;
  if (quantities(claim).some(quantity => !quotedQuantities.has(quantity))) return false;
  if (names(claim).some(name => !containsPhrase(quote, name))) return false;
  const languages = normalizeEvidence(claim).match(/\bc(?:\+\+|#)(?![\p{L}\p{N}+#])/gu) ?? [];
  const quotedLanguages: string[] = normalizeEvidence(quote).match(/\bc(?:\+\+|#)(?![\p{L}\p{N}+#])/gu) ?? [];
  if (languages.some(language => !quotedLanguages.includes(language))) return false;
  const tiers = new Set(['free', 'paid']);
  if (terms(claim).some(term => tiers.has(term) && !quoteTerms.has(term))) return false;
  const subject = lowercaseSubject(claim);
  if (subject && !containsPhrase(quote, subject)) return false;
  if (terms(claim).some(term => (negations.has(term) || units.has(term)) && !quoteTerms.has(term))) return false;
  // Material qualifiers must occur in this quote, not in a separate support or caveat (§4.5).
  const qualifierPattern = /\b(?:only if|only on|after|before|unless|on|in|if)\s+[^,.;!?]+/gu;
  const qualifiers = normalizeEvidence(claim).match(qualifierPattern) ?? [];
  return qualifiers.every(qualifier => normalizeEvidence(quote).includes(qualifier));
}

export function verifiedSupport(claim: string, support: Support, evidence: RetrievalEvidence): boolean {
  const quote = normalizeEvidence(support.quote);
  return evidence.completedSearchCalls > 0 && quote.length > 0
    && evidence.results.some(result => result.url === support.url
      && normalizeEvidence(result.snippet).includes(quote))
    && consistentClaim(claim, support.quote);
}
