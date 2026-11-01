import { expect, it } from 'vitest';
import { consistentClaim } from '../src/kernel/research/support.js';

it('rejects swapped number-unit pairs even when both numbers and both units appear', () => {
  expect(consistentClaim('Provider A offers 12 GB for 15 USD', 'Provider A offers 15 GB for 12 USD')).toBe(false);
});

it('preserves negative signs in numeric comparisons', () => {
  expect(consistentClaim('Provider A supports -12 degrees', 'Provider A supports 12 degrees')).toBe(false);
});

it('treats an unknown adjacent unit conservatively', () => {
  expect(consistentClaim('Provider A permits 12 widgets', 'Provider A permits 12 gadgets')).toBe(false);
});

it('checks spelled-out quantities', () => {
  expect(consistentClaim('Provider A allows twelve seats', 'Provider A allows fifteen seats')).toBe(false);
});

it('keeps product labels attached rather than accepting an unrelated article', () => {
  expect(consistentClaim('Provider A works offline', 'Provider B works offline with a network cache')).toBe(false);
});

it('preserves hyphenated proper names while allowing an ordinary verb paraphrase', () => {
  expect(consistentClaim('X-Cloud functions offline', 'X-Cloud works offline')).toBe(true);
});

it('does not exempt a lowercase product subject from quote consistency', () => {
  expect(consistentClaim('supabase works offline', 'firebase works offline')).toBe(false);
});

it('normalizes Unicode compatibility characters and quote whitespace', () => {
  expect(consistentClaim('Provider Ａ allows １２ GB', 'Provider A allows 12\nGB')).toBe(true);
});

it('checks curly-apostrophe negations', () => {
  expect(consistentClaim('Provider A didn’t work offline', 'Provider A worked offline')).toBe(false);
});

it('does not require ordinary predicate paraphrases to match', () => {
  expect(consistentClaim('Provider A functions reliably offline', 'Provider A works offline')).toBe(true);
});
