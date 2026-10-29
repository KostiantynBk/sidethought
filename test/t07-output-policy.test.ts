import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { outputFailure, OUTPUT_CHECK_NOTICE } from '../src/kernel/reply-output.js';
import { replyResult, streaming } from './t07-helpers.js';

it('blocks a direct API-key request split across model deltas', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'Please send me your API').state;
  const result = replyResult(partial, 'reply.chunk', ' key. ');
  expect(result.state.domain.reply?.status).toBe('aborted');
  expect(result.state.domain.replyPending).toBe(false);
  expect(result.effects.filter(effect => effect.type === 'client.send').map(effect => effect.message))
    .toEqual([{
      type: 'transcript.appended',
      text: OUTPUT_CHECK_NOTICE,
    }]);
  expect(JSON.stringify(result.state.domain.deliveries)).not.toContain('Please send');
});

it('checks the final sentence flushed by reply.done', () => {
  const partial = replyResult(streaming(), 'reply.chunk', 'Paste your password here.').state;
  const result = replyResult(partial, 'reply.done');
  expect(result.decisions[0]?.reason).toBe('reply:output_blocked');
  expect(result.effects.some(effect => effect.type === 'llm.abort')).toBe(true);
  expect(result.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'))
    .toBe(false);
});

it('allows ordinary advice about keeping secrets private', () => {
  expect(outputFailure('Keep passwords private.', loadConfig())).toBeUndefined();
});

it('rejects an https URL without finding provenance', () => {
  expect(outputFailure('See https://example.com/docs.', loadConfig())).toBe('url');
});

it('rejects a bare domain without finding provenance', () => {
  expect(outputFailure('See example.com for details.', loadConfig())).toBe('url');
});

it('rejects a www URL without finding provenance', () => {
  expect(outputFailure('See www.example.com.', loadConfig())).toBe('url');
});

it('rejects a mailto URL without finding provenance', () => {
  expect(outputFailure('Use mailto:hello@example.com.', loadConfig())).toBe('url');
});

it('rejects credentials requested in a question', () => {
  expect(outputFailure('What is your password?', loadConfig())).toBe('credential');
});

it('blocks asking what the user PIN is', () => {
  expect(outputFailure('What is your PIN?', loadConfig())).toBe('credential');
});

it('blocks asking for the user PIN with please', () => {
  expect(outputFailure('Your PIN, please.', loadConfig())).toBe('credential');
});

it('applies configured patterns before release', () => {
  const state = streaming();
  state.config = loadConfig({ credentialRequestPatterns: ['forbidden phrase'] });
  const result = replyResult(state, 'reply.chunk', 'A forbidden phrase. ');
  expect(result.state.domain.reply?.status).toBe('aborted');
});

it('rejects an empty credential policy rather than disabling checks', () => {
  expect(() => loadConfig({ credentialRequestPatterns: [] })).toThrow();
});

it('rejects an empty pattern', () => {
  expect(() => loadConfig({ credentialRequestPatterns: [''] })).toThrow();
});

it('rejects an invalid regular expression at configuration load', () => {
  expect(() => loadConfig({ credentialRequestPatterns: ['['] })).toThrow();
});

it('rejects a pattern longer than 512 characters', () => {
  expect(() => loadConfig({ credentialRequestPatterns: ['a'.repeat(513)] })).toThrow();
});

it('rejects more than 32 credential patterns', () => {
  expect(() => loadConfig({ credentialRequestPatterns: Array.from({ length: 33 }, () => 'password') })).toThrow();
});

it('accepts the configured regex list bounds', () => {
  expect(loadConfig({ credentialRequestPatterns: Array.from({ length: 32 }, () => 'a'.repeat(512)) })
    .credentialRequestPatterns).toHaveLength(32);
});

it('blocks credential requests separated by line breaks', () => {
  expect(outputFailure('Please send\nme your password.', loadConfig())).toBe('credential');
});

it('blocks a credential request containing an invisible formatting character', () => {
  expect(outputFailure('Please send your pass\u200bword.', loadConfig())).toBe('credential');
});
