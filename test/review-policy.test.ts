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

describe('prototype policy bounds', () => {
  it('rejects a 60-second checker timeout', () => {
    expect(() => loadConfig({ checkerTimeoutMs: 60000 })).toThrow();
  });
  it('rejects 100 concurrent workers', () => {
    expect(() => loadConfig({ jobsMaxConcurrent: 100 })).toThrow();
  });
  it('rejects a 10000 USD hard session cap for its field bound', () => {
    const result = ConfigSchema.safeParse({
      sessionHardCapUsd: 10000,
      developmentDailyCapUsd: 50,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'too_big',
            path: ['sessionHardCapUsd'],
            maximum: 25,
          }),
        ]),
      );
    }
  });
  it('rejects one million interpreter output tokens', () => {
    expect(() => loadConfig({ interpreterMaxOutputTokens: 1000000 })).toThrow();
  });
  it('enforces the soft cap bound independently of budget ordering', () => {
    const companions = {
      sessionHardCapUsd: 25,
      developmentDailyCapUsd: 50,
    };
    expect(
      ConfigSchema.safeParse({
        ...companions,
        sessionSoftCapUsd: 20,
      }).success,
    ).toBe(true);
    const result = ConfigSchema.safeParse({
      ...companions,
      sessionSoftCapUsd: 21,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: 'too_big',
          path: ['sessionSoftCapUsd'],
          maximum: 20,
        }),
      ]);
    }
  });
  it('enforces the hard cap bound independently of budget ordering', () => {
    const companions = {
      sessionSoftCapUsd: 3,
      developmentDailyCapUsd: 50,
    };
    expect(
      ConfigSchema.safeParse({
        ...companions,
        sessionHardCapUsd: 25,
      }).success,
    ).toBe(true);
    const result = ConfigSchema.safeParse({
      ...companions,
      sessionHardCapUsd: 26,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: 'too_big',
          path: ['sessionHardCapUsd'],
          maximum: 25,
        }),
      ]);
    }
  });
  it('enforces the daily cap field bound', () => {
    expect(ConfigSchema.safeParse({ developmentDailyCapUsd: 50 }).success).toBe(true);
    const result = ConfigSchema.safeParse({ developmentDailyCapUsd: 51 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: 'too_big',
          path: ['developmentDailyCapUsd'],
          maximum: 50,
        }),
      ]);
    }
  });
  it('enforces the judging reserve field bound', () => {
    expect(ConfigSchema.safeParse({ judgingReserveUsd: 150 }).success).toBe(true);
    const result = ConfigSchema.safeParse({ judgingReserveUsd: 151 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: 'too_big',
          path: ['judgingReserveUsd'],
          maximum: 150,
        }),
      ]);
    }
  });
  it('requires soft cap below hard cap', () => {
    expect(() =>
      loadConfig({
        sessionSoftCapUsd: 5,
        sessionHardCapUsd: 5,
      }),
    ).toThrow();
  });
  it('requires hard cap within daily cap', () => {
    expect(() =>
      loadConfig({
        sessionHardCapUsd: 11,
        developmentDailyCapUsd: 10,
      }),
    ).toThrow();
  });
  it('rejects tunable limits above immutable schema ceilings', () => {
    expect(() => loadConfig({ maxResearchRequestsPerInput: MAX_RESEARCH_REQUESTS_PER_INPUT + 1 })).toThrow();
    expect(() => loadConfig({ maxDeliberatorNominations: MAX_DELIBERATOR_NOMINATIONS + 1 })).toThrow();
    expect(
      loadConfig({
        maxResearchRequestsPerInput: 2,
        maxDeliberatorNominations: 2,
      }).maxResearchRequestsPerInput,
    ).toBe(2);
  });
});

const credential = '(?:passwords?|passcodes?|passphrases?|(?:api|secret|private|access|ssh)[ -]+keys?'
  + '|(?:api|access|auth|bearer)[ -]+tokens?|credentials?|login[ -]+details'
  + '|(?:seed|recovery)[ -]+phrases?|(?:2fa|otp|verification|one[ -]+time)[ -]+codes?|your[ -]+pin|(?<=your )pin)';
const verb = '(?:send|share|give|provide|disclose|tell|paste|enter|type|post|reveal|upload|submit'
  + '|forward|show|read[ -]+out)';
const gap = '(?:[^\\p{L}\\p{N}]+[\\p{L}\\p{N}]+){0,8}[^\\p{L}\\p{N}]*';
const expectedCredentialPatterns = [
  `\\b${verb}\\b${gap}\\b${credential}\\b`,
  `\\b(?:can|could|may)\\s+i\\s+(?:have|get|see|use)\\b${gap}\\b${credential}\\b`,
  `\\b(?:what\\s+is|what's)\\s+your\\b${gap}\\b${credential}\\b`,
  `\\b(?:i|we)\\s+need\\s+your\\b${gap}\\b${credential}\\b`,
  `\\byour\\s+${credential}\\b${gap}\\bplease\\b`,
];

it('matches the literal policy inventory and default values', () => {
  expect(loadConfig()).toEqual({
    configVersion: '0.3.8',
    credentialRequestPatterns: expectedCredentialPatterns,
    hedgeLexicon: ['might', 'maybe', 'perhaps', 'thinking about', 'I was thinking', 'not sure', 'possibly'],
    negationLexicon: ['not', 'no', 'never', "don't", "doesn't", "isn't", "won't", "can't"],
    replyDebounceMs: 800,
    voiceGraceMs: 300,
    recentWindowTurns: 20,
    interpreterSoftWaitMs: 600,
    firstTokenTimeoutMs: 8000,
    streamStallMs: 5000,
    callDeadlineMs: 20000,
    interpreterTimeoutMs: 15000,
    deliberatorTimeoutMs: 60000,
    checkerTimeoutMs: 15000,
    waitExpiryMs: 4000,
    answerWaitMs: 20000,
    userWaitMs: 20000,
    gapTextMs: 3000,
    gapVoiceMs: 1200,
    publicQueryMaxChars: 200,
    privateTermBlocklist: [],
    defaultResearchScopeCategories: [
      'public_technical_documentation',
      'pricing_and_limits',
      'licences',
      'existing_alternatives',
    ],
    jobsMaxConcurrent: 2,
    jobsMaxQueued: 4,
    jobsMaxPerSession: 15,
    jobDeadlineMs: 90000,
    jobMaxRetries: 1,
    jobDedupeWindowMs: 300000,
    jobEstimateUsd: 0.10,
    maxToolCallsPerSearch: 3,
    maxEvidenceResults: 20,
    maxSnippetChars: 2000,
    maxResearchRequestsPerInput: 3,
    autoAdmitMinConsequenceScore: 2,
    autoAdmitMinUncertaintyScore: 2,
    askMinConsequenceScore: 1,
    speakSpacingMs: 45000,
    candidateExpiryMs: 300000,
    blockerWindowMs: 300000,
    maxBlockersPerGap: 1,
    maxBlockersPerWindow: 2,
    maxCheckerSentences: 2,
    maxContributionsAfterResume: 1,
    maxCandidateInterruptions: 2,
    maxCheckerRechecks: 1,
    maxPatchConflictReinterpretations: 1,
    maxReplyReplays: 1,
    sessionSoftCapUsd: 3,
    sessionHardCapUsd: 5,
    developmentDailyCapUsd: 10,
    judgingReserveUsd: 40,
    searchUsdPerThousandQueries: 2.5,
    assumedQueriesPerToolCall: 3,
    transcriptionUsdPerHour: 0.18,
    deliberationDebounceMs: 2000,
    deliberatorEstimateUsd: 0.05,
    maxDeliberatorRunsPerInput: 3,
    maxDeliberatorRunsPerMinute: 4,
    maxDeliberatorNominations: 3,
    interpreterMaxOutputTokens: 1200,
    responderMaxOutputTokens: 800,
    deliberatorMaxOutputTokens: 6000,
    investigatorSearchMaxOutputTokens: 4000,
    investigatorStructureMaxOutputTokens: 3000,
    checkerMaxOutputTokens: 3000,
    voiceSampleRateHz: 24000,
    voiceFrameMinMs: 40,
    voiceFrameMaxMs: 80,
    sttHandshakeTimeoutMs: 10000,
    sttMaxAheadMs: 5000,
    sttSessionMaxMs: 3600000,
    backchannelMaxWords: 3,
    backchannelLexicon: ['yeah', 'mm-hmm', 'right', 'ok', 'uh-huh'],
    deliveryAckMs: 1500,
    responderMaxRetries: 1,
    interpreterRepairAttempts: 1,
    structuredRetryAttempts: 1,
    structuredRetryTokenMultiplier: 1.5,
  });
});
