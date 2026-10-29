import { expect, it } from 'vitest';
import type { State } from '../src/kernel/index.js';
import { replyResult, streaming } from './t07-helpers.js';

// Each case is exercised both at a streaming sentence boundary and at reply.done.
const blocked = [
  ['reviewer: can I have your password', 'Can I have your password?'],
  ['reviewer: could you disclose an API key', 'Could you disclose your API key?'],
  ['reviewer: abbreviation in request', 'Please send e.g. your password.'],
  ['reviewer: Cyrillic password', 'Please send your passwоrd.'],
  ['reviewer: network-path IPv4', 'Visit //127.0.0.1/admin.'],
  ['reviewer: network-path IDN', 'Visit //例子.测试/path.'],
  ['reviewer: IDNA dot', 'See example。com/path.'],
  ['imperative password', 'Send your password.'],
  ['passcode', 'Please share your passcode.'],
  ['passphrase', 'Give me your passphrase.'],
  ['private key', 'Provide your private key.'],
  ['access key', 'Upload your access key.'],
  ['SSH key', 'Please paste your SSH key.'],
  ['auth token', 'Please reveal your auth token.'],
  ['bearer token', 'Post your bearer token.'],
  ['login details', 'Please forward your login details.'],
  ['seed phrase', 'Show me your seed phrase.'],
  ['one-time code', 'Read out your one-time code.'],
  ['PIN', 'Type your PIN.'],
  ['need credentials', 'I need your credentials.'],
  ['please suffix', 'Your recovery phrase, please.'],
  ['PIN please suffix', 'Your PIN, please.'],
  ['PIN please without comma', 'Your PIN please.'],
  ['format character', 'Please send your pass\u200bword.'],
  ['https scheme', 'See https://example.com/docs.'],
  ['mailto scheme', 'Use mailto:hello@example.com.'],
  ['www hostname', 'Visit www.example.com.'],
  ['bare web domain', 'Visit example.org.'],
  ['bare host with path', 'Visit example.internal/path.'],
  ['IPv4 literal', 'Visit 127.0.0.1:8080.'],
  ['bracketed IPv6', 'Visit [2001:db8::1]/docs.'],
  ['bare IDN', 'Visit 例子.测试.'],
  ['web library trade-off', 'Use socket.io.'],
  ['review 2: semicolon caution', 'Please send your password; never share your API key.'],
  ['review 2: and caution', 'Send your password and never share your API key.'],
  ['review 2: but caution', 'Please send your password, but do not disclose your API key.'],
  ['semicolon later request', 'Never share your password; send your API key.'],
  ['but later request', 'Never share your password, but send your API key.'],
  ['and later request', 'Do not share your password and send your API key.'],
  ['comma and caution', 'Send your password, and never share your API key.'],
  ['semicolon dangling request', 'Please send it; your API key.'],
  ['dangling request and credential', 'Please send it and your API key.'],
  ['question request', 'Could you please disclose your password?'],
  ['unknown host query', 'Visit example.internal?query=value.'],
  ['unknown host port', 'Visit example.internal:8080.'],
  ['explicit file scheme', 'Visit https://example.ts/path.'],
  ['explicit file network path', 'Visit //example.js/path.'],
  ['explicit file www', 'Visit www.example.js.'],
] as const;

const benign = [
  ['probe: filenames', 'Edit index.ts and README.md first.'],
  ['probe: libraries', 'Next.js or Node.js would both work.'],
  ['probe: package', 'Put it in package.json.'],
  ['probe: key difference', 'What is the key difference between Postgres and SQLite?'],
  ['probe: caution', 'Never share your API key with anyone.'],
  ['reviewer: key requirement', 'What is your key requirement?'],
  ['protect password', 'Protect your password.'],
  ['rotate API key', 'Rotate your API key.'],
  ['revoke token', 'Revoke your access token.'],
  ['reset passcode', 'Reset your passcode.'],
  ['keep phrase', 'Keep your recovery phrase safe.'],
  ['store credentials', 'Store your credentials securely.'],
  ['do not send', 'Do not send your password.'],
  ['avoid disclosure', 'Avoid sharing your private key.'],
  ['nobody', 'Nobody should reveal your password.'],
  ['bare token', 'A token is a unit of text.'],
  ['bare code', 'The code is ready.'],
  ['bare PIN', 'A PIN can be numeric.'],
  ['decimal', 'The price is 12.50 today.'],
  ['version', 'The version is v0.3.3 today.'],
  ['abbreviation e.g.', 'Use a local file, e.g. a text document.'],
  ['abbreviation i.e.', 'Use one store, i.e. SQLite.'],
  ['abbreviation Dr.', 'Dr. Smith reviewed the design.'],
  ['abbreviation vs.', 'Compare SQLite vs. Postgres first.'],
  ['ordinary question', 'Would you describe the feature?'],
  ['review 2: server future', 'The server will send an OTP code.'],
  ['review 2: declarative how-to', 'I will show you how to rotate your API key.'],
  ['review 2: imperative how-to', 'Show me how to store my API key securely.'],
  ['review 2: package question', 'Which file should we edit: package.json?'],
  ['review 2: library question', 'Would you choose Next.js?'],
  ['review 2: line number', 'Check index.ts:42 for the error.'],
  ['review 2: anchor', 'Does README.md#setup explain the install?'],
  ['declarative future', 'The application will send a verification code.'],
  ['your server sends verification', 'Your server will send a verification code.'],
  ['your application sends OTP', 'Your application will send an OTP code.'],
  ['your server shows private key', 'Your server will show your private key.'],
  ['declarative private key', 'The server will show your private key.'],
  ['how-to rotate', 'Tell me how to rotate my API key.'],
  ['how-to question', 'Could you show me how to protect your password?'],
  ['filename question', 'Should we edit index.ts?'],
  ['filename line and column', 'Check index.ts:42:7 for the error.'],
  ['filename anchor', 'Read README.md#setup.'],
  ['filename punctuation', 'Choose package.json!'],
  ['caution after logs', 'Send the logs. Never share your password.'],
  ['password manager declarative', 'Please send it. Your password manager will autofill.'],
  ['carry stops after next clause', 'Please send it; we can proceed; your password.'],
  ['caution does not carry', 'Never send it; your password.'],
  ['caution cancels carry', 'Please send it; never disclose your password.'],
] as const;

type Result = ReturnType<typeof replyResult>;

function sentText(results: Result[]): string {
  return results.flatMap(result => result.effects)
    .filter(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk')
    .map(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk'
      ? effect.message.text : '')
    .join('');
}

function runSplit(sentence: string, boundary: 'stream' | 'flush'): Result[] {
  const midpoint = Math.floor(sentence.length / 2);
  const first = replyResult(streaming(), 'reply.chunk', sentence.slice(0, midpoint));
  const second = replyResult(first.state, 'reply.chunk', sentence.slice(midpoint) + (boundary === 'stream' ? ' ' : ''));
  const results = [first, second];
  if (boundary === 'flush' || second.state.domain.reply?.status === 'streaming') {
    results.push(replyResult(second.state, 'reply.done'));
  }
  return results;
}

function expectBlocked(results: Result[]) {
  expect(sentText(results)).toBe('');
  expect(results.some(result => result.decisions.some(decision => decision.reason === 'reply:output_blocked')))
    .toBe(true);
}

function runAfterPrevious(state: State, sentence: string): Result {
  return replyResult(state, 'reply.chunk', `${sentence} `);
}

for (const boundary of ['stream', 'flush'] as const) {
  it.each(blocked)(`blocks %s through split deltas and ${boundary}`, (_name, sentence) => {
    expectBlocked(runSplit(sentence, boundary));
  });

  it.each(benign)(`allows %s through split deltas and ${boundary}`, (_name, sentence) => {
    expect(sentText(runSplit(sentence, boundary)).trim()).toBe(sentence);
  });
}

it('checks a request across two released-sentence boundaries', () => {
  const previous = runAfterPrevious(streaming(), 'Please send it.');
  expect(sentText([previous]).trim()).toBe('Please send it.');
  const next = runAfterPrevious(previous.state, 'Your password.');
  expectBlocked([next]);
});

for (const boundary of ['stream', 'flush'] as const) {
  it.each([
    ['question', 'Can you share that?', 'Your API', ' key.'],
    ['imperative', 'Please send it.', 'Your pass', 'word.'],
  ])(`blocks a dangling %s and next credential through split deltas and ${boundary}`,
    (_name, first, part, rest) => {
      const previous = runAfterPrevious(streaming(), first);
      const partial = replyResult(previous.state, 'reply.chunk', part);
      const next = replyResult(partial.state, 'reply.chunk', rest + (boundary === 'stream' ? ' ' : ''));
      const results = [partial, next];
      if (boundary === 'flush') results.push(replyResult(next.state, 'reply.done'));
      expectBlocked(results);
    });
}

it('cancels dangling carry when the next clause is a declarative', () => {
  const previous = runAfterPrevious(streaming(), 'Please send it.');
  const next = runAfterPrevious(previous.state, 'Your password manager will autofill.');
  expect(sentText([next]).trim()).toBe('Your password manager will autofill.');
});

it('preserves abbreviation context across split deltas and final flush', () => {
  expectBlocked(runSplit('Please send e.g. your password.', 'flush'));
});
