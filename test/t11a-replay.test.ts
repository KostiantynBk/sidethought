import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';

it('replays S1 through the next model-context checkpoint identically in memory and real SQLite', () => {
  const path = 'fixtures/t11a/research-context.json';
  const memory = replayFixture(path, { store: 'memory' });
  const sqlite = replayFixture(path, { store: 'sqlite' });
  expect(memory.failures).toEqual([]);
  expect(sqlite.failures).toEqual([]);
  expect(sqlite.projection).toEqual(memory.projection);
  expect(sqlite.snapshot).toEqual(memory.snapshot);
  expect(memory.unflushedTelemetry).toEqual([]);
  expect(sqlite.unflushedTelemetry).toEqual([]);
  const domain = memory.snapshot!.state.domain;
  // T12: the verified finding becomes a promised evidence contribution; its closure counts only once
  // delivery starts, and this fixture has no connected client, so it is still waiting at the floor gate.
  expect(Object.values(domain.jobs)[0]?.closureCount).toBe(0);
  const pending = Object.values(domain.initiative.candidates);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.payload).toBe('evidence');
  expect(pending[0]?.class).toBe('speak');
  expect(pending[0]?.promised).toBe(true);
  expect(pending[0]?.state).toBe('candidate');
  expect(Object.values(domain.findings)[0]?.claims.map(claim => claim.support[0]?.quoteVerified))
    .toEqual([true, true, false]);
  const fixture = JSON.parse(readFileSync(path, 'utf8'));
  const input: string = fixture.contextCheckpoints[0].expected.input;
  expect(input).not.toContain('RAW_SNIPPET_ONLY');
  expect(JSON.parse(input).researchState.findings[0]).toMatchObject({
    id: 's.4.1',
    caveats: ['Card-only secondary note'],
  });
  expect(input).not.toContain('unlimited backups');
  expect(JSON.parse(input).researchState.findings[0].claims).toHaveLength(2);
});
