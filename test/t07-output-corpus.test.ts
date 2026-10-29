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

it('preserves abbreviation context across split deltas and final flush', () => {
  expectBlocked(runSplit('Please send e.g. your password.', 'flush'));
});
