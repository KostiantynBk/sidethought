import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { outputFailure } from '../src/kernel/reply-output.js';
import { replyResult, streaming } from './t07-helpers.js';

const headings = [
  ['the actual failed numbered step', '2. Check your data:\nUse one date column and one target column.'],
  ['an empty heading', 'Data:'],
  ['a markdown heading', '## Data:\nUse a small CSV.'],
  ['bold heading punctuation', '**Data:** one date column, one target column.'],
  ['a comma separated prose list', 'Check your data: dates, values, and missing rows.'],
] as const;

it.each(headings)('allows %s without treating a prose label as a data URI', (_name, text) => {
  expect(outputFailure(text, loadConfig())).toBeUndefined();
});

const dataUrls = [
  ['empty header and payload', 'data:,'],
  ['plain text', 'data:text/plain,hello'],
  ['base64', 'data:text/plain;base64,SGk='],
  ['parameter only', 'data:;charset=UTF-8,hello'],
  ['compact non-MIME header', 'data:payload,hello'],
  ['spaced MIME header', 'data: text/plain ; base64 , SGk='],
  ['space before MIME slash', 'data:text /plain,hello'],
  ['space after MIME slash', 'data:text/ plain,hello'],
  ['MIME prefix before comma arrives', 'data: text/plain;name=x. '],
  ['linebreak before MIME', 'data:\ntext/html,<b>hello</b>'],
  ['linebreak inside a header', 'data: text/html;\nbase64,SGk='],
  ['spaced empty header', 'data: ,hello'],
  ['spaced base64 without MIME', 'data: ;base64 , SGk='],
  ['fullwidth scheme punctuation', 'ｄａｔａ：，'],
  ['invisible formatting', 'da\u200bta:,hello'],
  ['URI inside code', '`value = "data:text/plain,hello"`'],
] as const;

it.each(dataUrls)('still rejects a data URI with %s', (_name, text) => {
  expect(outputFailure(text, loadConfig())).toBe('url');
});

it('allows a literal empty dataframe info call', () => {
  expect(outputFailure('Inspect the schema with `df.info()`.', loadConfig())).toBeUndefined();
});

it('allows whitespace inside an empty dataframe info call', () => {
  expect(outputFailure('Run df.info( ) first.', loadConfig())).toBeUndefined();
});

it.each([
  ['an ordinary info domain', 'Visit example.info().'],
  ['a bare df hostname', 'Visit df.info.'],
  ['a larger hostname', 'Visit x.df.info().'],
  ['a path after a call-shaped hostname', 'Visit df.info()/docs.'],
  ['a query after a call-shaped hostname', 'Visit df.info()?q=example.'],
  ['a port after a call-shaped hostname', 'Visit df.info():8080.'],
  ['an explicit scheme', 'Visit https://df.info().'],
  ['a network path', 'Visit //df.info().'],
  ['a code-block URL', '```python\nurl = "https://example.com"\n```'],
] as const)('still rejects %s', (_name, text) => {
  expect(outputFailure(text, loadConfig())).toBe('url');
});

it('keeps credential checking active alongside a benign heading and dataframe call', () => {
  expect(outputFailure('Check your data: run df.info(). Please send your password.', loadConfig()))
    .toBe('credential');
});

it('releases the failed user reply shape across streaming deltas and final flush', () => {
  let state = streaming();
  const messages: string[] = [];
  for (const delta of [
    'Start with a baseline.\n1. Define a target.\n2. Check your da',
    'ta:\nInspect the columns with `df.in',
    'fo()` and pick one timestamp.\n3. Run a small pilot.',
  ]) {
    const result = replyResult(state, 'reply.chunk', delta);
    state = result.state;
    messages.push(...result.effects.flatMap(effect => effect.type === 'client.send'
      && effect.message.type === 'assistant.chunk' ? [effect.message.text] : []));
    expect(state.domain.reply?.status).toBe('streaming');
  }
  const done = replyResult(state, 'reply.done');
  expect(done.state.domain.reply?.status).toBe('done');
  messages.push(...done.effects.flatMap(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk' ? [effect.message.text] : []));
  expect(messages.join('')).toContain('2. Check your data:\nInspect the columns with `df.info()`');
});

it('blocks a MIME header before it can span multiple released sentences', () => {
  const first = replyResult(streaming(), 'reply.chunk', 'Open data: text/plain;name=x. ');
  expect(first.state.domain.reply?.status).toBe('aborted');
  expect(first.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(false);
});

it('blocks a data URI split across deltas before its sentence is released', () => {
  const first = replyResult(streaming(), 'reply.chunk', 'Open data: text/');
  const second = replyResult(first.state, 'reply.chunk', 'html;base64,SGk=');
  const done = replyResult(second.state, 'reply.done');
  expect(done.state.domain.reply?.status).toBe('aborted');
  expect([...first.effects, ...second.effects, ...done.effects].some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(false);
});
