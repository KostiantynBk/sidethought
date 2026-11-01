import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { outputFailure } from '../src/kernel/reply-output.js';

const url = 'https://provider.example/docs/offline';

it('allows an exact verified URL with balanced path parentheses and surrounding punctuation', () => {
  const allowed = 'https://en.wikipedia.org/wiki/C_(programming_language)';
  expect(outputFailure(`See ${allowed} for details.`, loadConfig(), [allowed])).toBeUndefined();
  expect(outputFailure(`See (${allowed}).`, loadConfig(), [allowed])).toBeUndefined();
  expect(outputFailure(`See ${allowed}/attacker`, loadConfig(), [allowed])).toBe('url');
});

it('preserves the T13 prose and dataframe exceptions with a verified URL', () => {
  const text = `Check your data: run df.info() and see ${url} for details.`;
  expect(outputFailure(text, loadConfig(), [url])).toBeUndefined();
});

it('still blocks a data URI when the same sentence contains a verified URL', () => {
  const text = `See ${url}, then open data:text/html,example.`;
  expect(outputFailure(text, loadConfig(), [url])).toBe('url');
});

it('still blocks a credential request when the same sentence contains a verified URL', () => {
  const text = `See ${url} and send me your password.`;
  expect(outputFailure(text, loadConfig(), [url])).toBe('credential');
});

it('still blocks a non-allowlisted dataframe-like URL', () => {
  const text = `See ${url} and https://df.info/other.`;
  expect(outputFailure(text, loadConfig(), [url])).toBe('url');
});
