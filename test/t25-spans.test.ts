import { expect, it } from 'vitest';
import type { QuoteSpan } from '../src/contract/index.js';
import type { QuoteInput } from '../src/kernel/items/spans.js';
import { repairInterpreterSpan } from '../src/model/meta/interpreter-spans.js';

function source(text: string): QuoteInput {
  return {
    id: 'input',
    text,
    origin: 'user',
    modality: 'text',
  };
}

function span(quote: string, start: number, end = start + quote.length): QuoteSpan {
  return {
    inputId: 'input',
    start,
    end,
    quote,
  };
}

function repair(text: string, quote: string): QuoteSpan {
  return repairInterpreterSpan(span(quote, text.indexOf(quote)), [source(text)]);
}

function unchanged(prefix: string): void {
  const quote = 'we will use Pro.';
  const text = `${prefix} ${quote}`;
  expect(repair(text, quote)).toEqual(span(quote, prefix.length + 1));
}

it('widens a quote over Actually and updates both offsets and exact wording', () => {
  const text = 'Actually, we will use Pro.';
  expect(repair(text, 'we will use Pro.')).toEqual(span(text, 0));
});

it('widens over a sequence of allowlisted words and punctuation', () => {
  const text = 'OK so, well, we will use Pro.';
  expect(repair(text, 'we will use Pro.').quote).toBe(text);
});

it('does not widen over My cofounder thinks', () => {
  unchanged('My cofounder thinks');
});

it('does not widen over not', () => {
  unchanged('not');
});

it('does not widen over maybe', () => {
  unchanged('maybe');
});

it('does not widen over if', () => {
  unchanged('if');
});

it('does not widen over unless', () => {
  unchanged('unless');
});

it('does not widen over a number', () => {
  unchanged('42');
});

it('does not widen over a name', () => {
  unchanged('Alice says');
});

it('does not widen over Please update that requirement and', () => {
  unchanged('Please update that requirement and');
});

it('does not widen over a hedge following an allowed word', () => {
  unchanged('Actually, maybe');
});

it('extends the end over trailing punctuation only', () => {
  const text = 'Use Pro),.';
  expect(repair(text, 'Use Pro')).toEqual(span(text, 0));
});

it('does not extend the end over a substantive word', () => {
  expect(repair('Use Pro unless offline.', 'Use Pro').quote).toBe('Use Pro');
});

it('does not cross a sentence boundary to include other words', () => {
  expect(repair('Actually, use Pro. Not Free.', 'use Pro').quote).toBe('Actually, use Pro.');
});

it('does not treat a decimal period as a new clause', () => {
  expect(repair('Maybe 2.5 users will use Pro.', 'users will use Pro.').quote).toBe('users will use Pro.');
});

it('does not repair a quote that cuts a word after an allowlisted prefix', () => {
  expect(repair('something will use Pro.', 'mething will use Pro.').quote).toBe('mething will use Pro.');
});

it('does not repair a missing quote by trusting offsets', () => {
  const original = span('imaginary text', 10, 24);
  expect(repairInterpreterSpan(original, [source('Actually, we will use Pro.')])).toEqual(original);
});

it('uses unique quote resolution before repairing inaccurate offsets', () => {
  const text = 'Actually, we will use Pro.';
  expect(repairInterpreterSpan(span('we will use Pro.', 9, 15), [source(text)])).toEqual(span(text, 0));
});

it('does not repair ambiguous quotes', () => {
  const text = 'Actually, use Pro. Actually, use Pro.';
  const original = span('use Pro.', 1, 3);
  expect(repairInterpreterSpan(original, [source(text)])).toEqual(original);
});

it('keeps multi-clause quotes exact while widening only the outer safe boundaries', () => {
  const text = 'Actually, use Pro. Keep backups.';
  expect(repair(text, 'use Pro. Keep backups').quote).toBe(text);
});

it('does not mutate the supplied quote', () => {
  const original = span('use Pro.', 10, 18);
  const before = structuredClone(original);
  repairInterpreterSpan(original, [source('Actually, use Pro.')]);
  expect(original).toEqual(before);
});
