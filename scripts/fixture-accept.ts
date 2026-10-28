import { readFileSync, writeFileSync } from 'node:fs';
import { replayFixture } from '../src/harness/index.js';
const path = process.argv[2];
if (!path) throw new Error('usage: npm run fixture:accept -- <file>');
const result = replayFixture(path);
const blocked = result.failures.some(failure =>
  failure.class === 'harness' || failure.class === 'fixture_schema' || failure.class === 'invariant',
);
if (!result.projection || blocked) {
  throw new Error(`cannot accept: ${JSON.stringify(result.failures)}`);
}
const fixture = JSON.parse(readFileSync(path, 'utf8')) as { expected: unknown };
const oldLines = JSON.stringify(fixture.expected, null, 2).split('\n');
const newLines = JSON.stringify(result.projection, null, 2).split('\n');
console.log('--- current expected\n+++ proposed expected');
if (oldLines.join('\n') !== newLines.join('\n')) {
  for (const line of oldLines) console.log('-' + line);
  for (const line of newLines) console.log('+' + line);
} else console.log(' (no changes)');
if (!process.stdin.isTTY) throw new Error('requires interactive human confirmation');
process.stdout.write('Type ACCEPT to write: ');
const buf = Buffer.alloc(32);
const { readSync } = await import('node:fs');
const n = readSync(0, buf, 0, buf.length, null);
if (buf.subarray(0, n).toString().trim() !== 'ACCEPT') throw new Error('not accepted');
fixture.expected = result.projection;
writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
