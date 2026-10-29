import type { Config } from '../../config/index.js';
import type { QuoteSpan } from '../../contract/index.js';
import { extractAmounts } from './amounts.js';
import { normalize } from './normalize.js';
import { quoteMatches } from './quote-search.js';

export { normalize } from './normalize.js';

export type QuoteInput = {
  id: string;
  text: string;
  origin: 'user' | 'assistant';
  modality: 'text' | 'voice';
};
export type SpanOp = {
  text: string;
  status: string;
  quoteSpans: QuoteSpan[];
};
export type SpanDecision = {
  allowed: boolean;
  status: string;
  reason: string;
};

// AD-5 v0.3.3 E1: offsets are checked first; quote resolution is a separate reducer step.
function resolveSpan(span: QuoteSpan, input: QuoteInput | undefined): string | undefined {
  if (!input || span.start < 0 || span.end > input.text.length || span.end <= span.start) return undefined;
  const slice = input.text.slice(span.start, span.end);
  return normalize(slice) === normalize(span.quote) ? slice : undefined;
}

type QuoteResolution = {
  span: QuoteSpan;
  decision?: 'span:resolved_by_quote' | 'span:quote_not_found' | 'span:quote_ambiguous';
};

export function resolveQuoteSpan(span: QuoteSpan, input: QuoteInput | undefined): QuoteResolution {
  if (!input || input.id !== span.inputId || resolveSpan(span, input) !== undefined) return { span };
  const quote = normalize(span.quote);
  const matches = quote ? quoteMatches(input.text, quote, span.quote.trim()) : [];
  if (matches.length !== 1) {
    return {
      span,
      decision: matches.length ? 'span:quote_ambiguous' : 'span:quote_not_found',
    };
  }
  return {
    span: {
      ...span,
      ...matches[0]!,
    },
    decision: 'span:resolved_by_quote',
  };
}

export function spansMatch(spans: QuoteSpan[], inputs: QuoteInput[]): boolean {
  return spans.every(
    (span) =>
      resolveSpan(
        span,
        inputs.find((input) => input.id === span.inputId),
      ) !== undefined,
  );
}

function containsTerm(text: string, lexicon: string[]): boolean {
  const source = ` ${normalize(text)} `;
  return lexicon.some((term) => {
    const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(source);
  });
}

type Clause = {
  text: string;
  start: number;
  end: number;
  question: boolean;
};
function clauses(text: string): Clause[] {
  const result: Clause[] = [];
  // A period between digits belongs to the numeric lexeme, not a sentence boundary (decision 17).
  const re = /(?:(?<=\d)\.(?=\d)|[^.!?;\n])+(?:[.!?;]|\n|$)/g;
  for (const match of text.matchAll(re)) {
    const value = match[0];
    const lead = value.length - value.trimStart().length;
    const content = value
      .trim()
      .replace(/[.!?;]$/, '')
      .trimEnd();
    if (!content) continue;
    const start = match.index + lead;
    const question =
      /\?\s*$/.test(value) ||
      /^(anything|any|what|which|who|how|is|are|do|does|can|could|should|would|will)\b/i.test(content);
    result.push({
      text: content,
      start,
      end: start + content.length,
      question,
    });
  }
  return result;
}

const stopwords = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'will',
  'would',
  'could',
  'should',
  'like',
  'what',
  'your',
  'their',
  'they',
  'them',
  'then',
  'than',
  'into',
  'about',
  'there',
  'here',
  'some',
  'more',
  'only',
  'over',
  'under',
]);
function tokens(value: string): string[] {
  const { remainder, amounts } = extractAmounts(normalize(value));
  const words =
    remainder
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => /\d/.test(token) || (token.length > 3 && !stopwords.has(token))) ?? [];
  const amountNumbers = amounts.filter((amount) => !amount.startsWith('UNMATCHED:'))
    .map((amount) => amount.split(':')[1]!);
  return [...amounts, ...amountNumbers, ...words];
}
function assistantOnly(op: SpanOp, spans: { input: QuoteInput; text: string }[]): boolean {
  const user = new Set(spans.filter((span) => span.input.origin === 'user').flatMap((span) => tokens(span.text)));
  const assistant = new Set(
    spans.filter((span) => span.input.origin === 'assistant').flatMap((span) => tokens(span.text)),
  );
  return tokens(op.text).some((token) => token.startsWith('UNMATCHED:')
    || (assistant.has(token) && !user.has(token)));
}

type ExtractedSpan = {
  input: QuoteInput;
  text: string;
  hedge: boolean;
  question: boolean;
};
type SpanInspection = { result: ExtractedSpan } | { reason: string };

function clauseFailure(clause: Clause, span: QuoteSpan, input: QuoteInput, config: Config): string | undefined {
  const outside =
    input.text.slice(clause.start, Math.max(clause.start, span.start)) +
    ' ' +
    input.text.slice(Math.min(clause.end, span.end), clause.end);
  if (containsTerm(outside, config.negationLexicon)) return 'span:negated_outside';
  if (span.start > clause.start || span.end < clause.end) return 'span:partial_clause';
  return undefined;
}

function cutsNumericLexeme(text: string, at: number): boolean {
  const left = text[at - 1] ?? '';
  const right = text[at] ?? '';
  const digit = (value: string) => /^[0-9]$/.test(value);
  const separator = (value: string) => value === '.' || value === ',';
  return (digit(left) && digit(right))
    || (digit(left) && separator(right) && digit(text[at + 1] ?? ''))
    || (separator(left) && digit(text[at - 2] ?? '') && digit(right));
}

function inspectSpan(span: QuoteSpan, inputs: QuoteInput[], config: Config): SpanInspection {
  const input = inputs.find((entry) => entry.id === span.inputId);
  const text = resolveSpan(span, input);
  if (!input || text === undefined) return { reason: 'span:mismatch' };
  if (cutsNumericLexeme(input.text, span.start) || cutsNumericLexeme(input.text, span.end)) {
    return { reason: 'span:partial_clause' };
  }
  const relevant = clauses(input.text).filter((clause) => span.start < clause.end && span.end > clause.start);
  if (!relevant.length) return { reason: 'span:partial_clause' };
  for (const clause of relevant) {
    const reason = clauseFailure(clause, span, input, config);
    if (reason) return { reason };
  }
  return {
    result: {
      input,
      text,
      hedge: relevant.some((clause) => containsTerm(clause.text, config.hedgeLexicon)),
      question: relevant.some((clause) => clause.question),
    },
  };
}

function allowedStatus(op: SpanOp, spans: ExtractedSpan[]): SpanDecision {
  if (op.status === 'stated' && spans.some((span) => span.hedge)) {
    return {
      allowed: true,
      status: 'considering',
      reason: 'status:forced_considering:hedge',
    };
  }
  if (op.status === 'stated' && assistantOnly(op, spans)) {
    return {
      allowed: true,
      status: 'considering',
      reason: 'status:forced_considering:assistant_only',
    };
  }
  if (op.status === 'stated' && spans.some((span) => span.question)) {
    return {
      allowed: true,
      status: 'considering',
      reason: 'status:capped:question',
    };
  }
  return {
    allowed: true,
    status: op.status,
    reason: 'span:valid',
  };
}

export function validateSpans(op: SpanOp, inputs: QuoteInput[], config: Config): SpanDecision {
  const extracted: ExtractedSpan[] = [];
  if (!op.quoteSpans.length)
    return {
      allowed: false,
      status: op.status,
      reason: 'span:mismatch',
    };
  for (const span of op.quoteSpans) {
    const inspected = inspectSpan(span, inputs, config);
    if ('reason' in inspected)
      return {
        allowed: false,
        status: op.status,
        reason: inspected.reason,
      };
    extracted.push(inspected.result);
  }
  return allowedStatus(op, extracted);
}
