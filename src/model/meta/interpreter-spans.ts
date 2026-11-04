import type { InterpreterOutput, QuoteSpan } from '../../contract/index.js';
import { resolveQuoteSpan, type QuoteInput } from '../../kernel/items/spans.js';

const leadingWords = new Set([
  'actually',
  'ok',
  'okay',
  'so',
  'well',
  'alright',
  'right',
  'now',
  'oh',
  'hey',
  'also',
  'and',
]);
const punctuation = /^[\p{P}\s]*$/u;
const word = /[\p{L}\p{M}\p{N}_]/u;
type Boundary = {
  start: number;
  end: number;
};

// Same clause segmentation as items/spans.ts, without changing/exporting kernel internals.
// Decimal periods are not boundaries. Include terminal punctuation for exact source quotes.
function boundaries(text: string): Boundary[] {
  const result: Boundary[] = [];
  const re = /(?:(?<=\d)\.(?=\d)|[^.!?;\n])+(?:[.!?;]|\n|$)/g;
  for (const match of text.matchAll(re)) {
    const value = match[0];
    const lead = value.length - value.trimStart().length;
    const content = value.trim().replace(/[.!?;]$/, '').trimEnd();
    if (!content) continue;
    result.push({
      start: match.index + lead,
      end: match.index + value.trimEnd().length,
    });
  }
  return result;
}

function allowedPrefix(text: string): boolean {
  const words = text.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  return words.every(value => leadingWords.has(value.toLowerCase()))
    && punctuation.test(text.replace(/[\p{L}\p{M}\p{N}_]+/gu, ''));
}

function cutsWord(text: string, at: number): boolean {
  return word.test(text[at - 1] ?? '') && word.test(text[at] ?? '');
}

export function repairInterpreterSpan(span: QuoteSpan, sources: readonly QuoteInput[]): QuoteSpan {
  const input = sources.find(source => source.id === span.inputId);
  if (!input) return span;
  // Resolve the authoritative quote using the existing unique-match policy before trusting offsets.
  const resolved = resolveQuoteSpan(span, input);
  if (resolved.decision && resolved.decision !== 'span:resolved_by_quote') return span;
  const base = resolved.span;
  if (base.start < 0 || base.end > input.text.length || base.end <= base.start
    || cutsWord(input.text, base.start) || cutsWord(input.text, base.end)) return span;
  const relevant = boundaries(input.text).filter(clause => base.start < clause.end && base.end > clause.start);
  const first = relevant[0];
  const last = relevant.at(-1);
  if (!first || !last) return span;
  const start = base.start > first.start && allowedPrefix(input.text.slice(first.start, base.start))
    ? first.start : base.start;
  const end = base.end < last.end && punctuation.test(input.text.slice(base.end, last.end))
    ? last.end : base.end;
  if (start === base.start && end === base.end) return span;
  return {
    ...span,
    start,
    end,
    quote: input.text.slice(start, end),
  };
}

// Called only after schema validation, before emitting interpretation.ready for journaling.
export function repairInterpreterSpans(output: InterpreterOutput, sources: readonly QuoteInput[]): InterpreterOutput {
  const repair = (span: QuoteSpan) => repairInterpreterSpan(span, sources);
  const op = (value: InterpreterOutput['ops'][number]): InterpreterOutput['ops'][number] => ({
    ...value,
    quoteSpans: value.quoteSpans.map(repair),
    ...(value.op === 'supersede' ? {
      replacement: {
        ...value.replacement,
        quoteSpans: value.replacement.quoteSpans.map(repair),
      },
    } : {}),
  });
  return {
    ...output,
    ops: output.ops.map(op),
    replacementGroups: output.replacementGroups.map(group => ({ ops: group.ops.map(op) })),
  };
}
