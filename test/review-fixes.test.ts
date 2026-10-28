import { describe, expect, it } from 'vitest';
import {
  EventSchema,
  FindingSchema,
  InvestigatorOutputSchema,
  MAX_DELIBERATOR_NOMINATIONS,
  MAX_RESEARCH_REQUESTS_PER_INPUT,
  retrievalEvidenceSchemaWithLimits,
  eventSchemaWithEvidenceLimits,
} from '../src/contract/index.js';
import { ConfigSchema, loadConfig } from '../src/config/index.js';

const output = {
  verdict: 'inconclusive',
  claims: [],
  caveats: [],
};
const evidence = {
  completedSearchCalls: 1,
  issuedQueries: ['public query'],
  results: [
    {
      url: 'https://example.com',
      snippet: 'Quoted evidence',
    },
  ],
};
const baseFinding = {
  id: 'f',
  jobId: 'j',
  questionKey: 'q',
  verdict: 'inconclusive',
  claims: [],
  caveats: [],
  retrievedAt: 1,
  basisRev: 0,
  inputDeps: [],
  deps: [],
  rebases: [],
  validity: { state: 'current' },
};

describe('replayable research evidence', () => {
  it('accepts a researched finding with journaled evidence', () => {
    expect(
      FindingSchema.safeParse({
        ...baseFinding,
        retrievalEvidence: evidence,
      }).success,
    ).toBe(true);
  });
  it('accepts no-search evidence with not_researched outcome', () => {
    const noSearch = {
      completedSearchCalls: 0,
      issuedQueries: [],
      results: [],
    };
    expect(
      FindingSchema.safeParse({
        ...baseFinding,
        verdict: 'not_researched',
        retrievalEvidence: noSearch,
      }).success,
    ).toBe(true);
  });
  it('rejects a researched classification without a completed search', () => {
    const noSearch = {
      completedSearchCalls: 0,
      issuedQueries: [],
      results: [],
    };
    expect(
      FindingSchema.safeParse({
        ...baseFinding,
        retrievalEvidence: noSearch,
      }).success,
    ).toBe(false);
  });
  it('journals model output and evidence separately in job completion', () => {
    const event = {
      eventId: 'e',
      sessionId: 's',
      type: 'job.completed',
      payload: {
        jobId: 'j',
        callId: 'c',
        investigatorOutput: output,
        retrievalEvidence: evidence,
      },
    };
    expect(EventSchema.safeParse(event).success).toBe(true);
  });
  it('applies configured evidence caps to job completion events', () => {
    const schema = eventSchemaWithEvidenceLimits({
      maxEvidenceResults: 1,
      maxSnippetChars: 4,
    });
    const event = {
      eventId: 'e',
      sessionId: 's',
      type: 'job.completed',
      payload: {
        jobId: 'j',
        callId: 'c',
        investigatorOutput: output,
        retrievalEvidence: evidence,
      },
    };
    expect(schema.safeParse(event).success).toBe(false);
    expect(
      schema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          retrievalEvidence: {
            ...evidence,
            results: [
              {
                url: 'https://example.com',
                snippet: 'text',
              },
            ],
          },
        },
      }).success,
    ).toBe(true);
  });
  it('rejects application evidence in model output', () => {
    expect(
      InvestigatorOutputSchema.safeParse({
        ...output,
        retrievalEvidence: evidence,
      }).success,
    ).toBe(false);
  });
  it('rejects verification flags in model output', () => {
    const support = {
      url: 'https://example.com',
      quote: 'text',
      sourceKind: 'official',
      quoteVerified: true,
    };
    expect(
      InvestigatorOutputSchema.safeParse({
        ...output,
        claims: [
          {
            text: 'text',
            support: [support],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('enforces configured result and snippet limits', () => {
    const schema = retrievalEvidenceSchemaWithLimits({
      maxEvidenceResults: 1,
      maxSnippetChars: 4,
    });
    expect(
      schema.safeParse({
        ...evidence,
        results: [
          {
            url: 'https://example.com',
            snippet: 'text',
          },
        ],
      }).success,
    ).toBe(true);
    expect(schema.safeParse(evidence).success).toBe(false);
    expect(
      schema.safeParse({
        ...evidence,
        results: [
          {
            url: 'https://example.com',
            snippet: 'a',
          },
          {
            url: 'https://example.com',
            snippet: 'b',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

