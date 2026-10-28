import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventSchemaWithEvidenceLimits } from '../src/contract/index.js';
import { loadConfig } from '../src/config/index.js';

export const basicPath = 'fixtures/commit-basic.json';
export const basicSource = readFileSync(basicPath, 'utf8');
export const config = loadConfig();
export const parse = eventSchemaWithEvidenceLimits(config).parse;
export const readyOutput = {
  inputKinds: [{
    inputId: 's.1.1',
    kind: 'statement',
  }],
  ops: [],
  replacementGroups: [],
  researchRequests: [],
  deprioritizedTopics: [],
  voiceConfirmValues: [],
};

export function basicFixture() {
  return JSON.parse(basicSource);
}

export function withTemporary<T>(body: string, run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'st-t03-'));
  const path = join(dir, 'fixture.json');
  try {
    writeFileSync(path, body);
    return run(path);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  }
}

export function commit(eventId: string, clientMsgId: string, at: number) {
  return parse({
    eventId,
    sessionId: 's',
    acceptedAt: at,
    type: 'input.committed',
    payload: {
      clientMsgId,
      text: 'x',
      modality: 'text',
    },
  });
}
