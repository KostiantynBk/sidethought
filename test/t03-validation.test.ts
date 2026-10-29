import { describe, expect, it } from 'vitest';
import { replayFixture } from '../src/harness/index.js';
import { basicFixture, config, withTemporary } from './t03-helpers.js';

describe('fixture validation and timer ordering', () => {
  it('rejects evidence exceeding the configured snippet cap', () => {
    const fixture = basicFixture();
    fixture.events = [{
      at: 0,
      event: {
        eventId: 'bad',
        sessionId: 's',
        type: 'job.completed',
        payload: {
          jobId: 'j',
          callId: 'c',
          investigatorOutput: {
            verdict: 'inconclusive',
            claims: [],
            caveats: [],
          },
          retrievalEvidence: {
            completedSearchCalls: 1,
            issuedQueries: [],
            results: [{
              url: 'https://example.com',
              snippet: 'x'.repeat(config.maxSnippetChars + 1),
            }],
          },
        },
      },
    }];
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path);
      expect(result.ok).toBe(false);
      expect(result.failures[0]?.class).toBe('fixture_schema');
    });
  });

  it('processes an external event before a timer at the same time', () => {
    const fixture = basicFixture();
    fixture.endAt = 800;
    fixture.events.push({
      at: 800,
      event: {
        eventId: 'activity',
        sessionId: 's',
        type: 'input.activity',
        payload: {
          channel: 'composer',
          active: true,
        },
      },
    });
    withTemporary(JSON.stringify(fixture), path => {
      const result = replayFixture(path);
      expect(result.projection?.decisions.map(decision => decision.reason)).toEqual([
        'input:committed',
        'input:activity',
        'reply:composer_active',
      ]);
    });
  });
});
