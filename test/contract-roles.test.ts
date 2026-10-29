import { describe, it, expect } from 'vitest';
import {
  EventSchema,
  EffectSchema,
  InterpreterOutputSchema,
  DeliberatorOutputSchema,
  InvestigatorOutputSchema,
  CheckerOutputSchema,
  ResponderPassSchema,
  KernelIdSchema,
  kernelId,
  TimerPurposeSchema,
  AppliedPatchBatchSchema,
} from '../src/contract/index.js';
import { ConfigSchema, loadConfig } from '../src/config/index.js';

const env = {
  eventId: 'e',
  sessionId: 's',
};
const request = {
  inputId: 'i1',
  question: 'q',
  publicQuery: 'public',
  depItemIds: [],
};
const interpreter = {
  inputKinds: [{
    inputId: 'i1',
    kind: 'statement',
  }],
  ops: [],
  replacementGroups: [],
  researchRequests: [],
  deprioritizedTopics: [],
  voiceConfirmValues: [],
};
const event = (type: string, payload: unknown) => ({
  ...env,
  type,
  payload,
});

describe('role outputs', () => {
  it('accepts zero to three requests per input', () => {
    for (let n = 0; n <= 3; n++) {
      expect(
        InterpreterOutputSchema.safeParse({
          ...interpreter,
          researchRequests: Array(n).fill(request),
        }).success,
      ).toBe(true);
    }
  });
  it('rejects four requests for one input', () => {
    expect(
      InterpreterOutputSchema.safeParse({
        ...interpreter,
        researchRequests: Array(4).fill(request),
      }).success,
    ).toBe(false);
  });
  it('accepts three requests for each of two inputs', () => {
    const requests = [
      ...Array(3).fill(request),
      ...Array(3).fill({
        ...request,
        inputId: 'i2',
      }),
    ];
    expect(
      InterpreterOutputSchema.safeParse({
        ...interpreter,
        researchRequests: requests,
      }).success,
    ).toBe(true);
  });
  it('rejects requests without input IDs', () => {
    expect(
      InterpreterOutputSchema.safeParse({
        ...interpreter,
        researchRequests: [
          {
            question: 'q',
            publicQuery: 'p',
            depItemIds: [],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('accepts wait and deferral kinds', () => {
    for (const kind of ['wait', 'deferral']) {
      expect(
        InterpreterOutputSchema.safeParse({
          ...interpreter,
          inputKinds: [{
            inputId: 'i1',
            kind,
          }],
        }).success,
      ).toBe(true);
    }
  });
  it('represents a replacement group', () => {
    const quoteSpans = [
      {
        inputId: 'in',
        start: 0,
        end: 3,
        quote: 'new',
      },
    ];
    const group = {
      ops: [
        {
          op: 'supersede',
          itemId: 'i',
          quoteSpans,
          replacement: {
            kind: 'requirement',
            status: 'stated',
            text: 'new',
            quoteSpans,
          },
        },
        {
          op: 'create',
          kind: 'requirement',
          status: 'stated',
          text: 'new',
          quoteSpans,
        },
      ],
    };
    expect(
      InterpreterOutputSchema.safeParse({
        ...interpreter,
        replacementGroups: [group],
      }).success,
    ).toBe(true);
  });
  it('binds versions only after model output', () => {
    const quoteSpans = [
      {
        inputId: 'in',
        start: 0,
        end: 3,
        quote: 'new',
      },
    ];
    const op = {
      op: 'supersede',
      itemId: 'i',
      quoteSpans,
      replacement: {
        kind: 'requirement',
        status: 'stated',
        text: 'new',
        quoteSpans,
      },
    };
    expect(
      InterpreterOutputSchema.safeParse({
        ...interpreter,
        ops: [op],
      }).success,
    ).toBe(true);
    expect(
      InterpreterOutputSchema.safeParse({
        ...interpreter,
        ops: [
          {
            ...op,
            seenContentVersion: 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AppliedPatchBatchSchema.safeParse({
        requestId: 'r',
        callId: 'c',
        ops: [
          {
            ...op,
            seenContentVersion: 1,
          },
        ],
        replacementGroups: [],
      }).success,
    ).toBe(true);
    expect(
      AppliedPatchBatchSchema.safeParse({
        requestId: 'r',
        callId: 'c',
        ops: [op],
        replacementGroups: [],
      }).success,
    ).toBe(false);
  });
  it('validates deliberator scores', () => {
    const nomination = {
      kind: 'investigation',
      question: 'q',
      publicQuery: 'q',
      topic: 'q',
      depItemIds: [],
      scores: {
        consequence: 2,
        uncertainty: 2,
        answerable: true,
        urgency: 1,
        needsPrivateDetail: false,
      },
    };
    expect(DeliberatorOutputSchema.safeParse({ nominations: [nomination] }).success).toBe(true);
    expect(
      DeliberatorOutputSchema.safeParse({
        nominations: [
          {
            ...nomination,
            scores: {
              ...nomination.scores,
              consequence: 4,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('validates investigator verdicts and unverified support', () => {
    const body = {
      verdict: 'inconclusive',
      claims: [],
      caveats: [],
    };
    const support = {
      url: 'https://example.com',
      quote: 'evidence',
      sourceKind: 'official',
    };
    expect(InvestigatorOutputSchema.safeParse(body).success).toBe(true);
    expect(
      InvestigatorOutputSchema.safeParse({
        ...body,
        verdict: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      InvestigatorOutputSchema.safeParse({
        ...body,
        verdict: 'not_researched',
      }).success,
    ).toBe(false);
    expect(
      InvestigatorOutputSchema.safeParse({
        ...body,
        claims: [
          {
            text: 'x',
            support: [support],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      InvestigatorOutputSchema.safeParse({
        ...body,
        claims: [
          {
            text: 'x',
            support: [
              {
                ...support,
                quoteVerified: true,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('validates checker output', () => {
    expect(
      CheckerOutputSchema.safeParse({
        applies: true,
        reason: 'ok',
        utterance: 'hello',
        claimsUsed: [],
      }).success,
    ).toBe(true);
    expect(CheckerOutputSchema.safeParse({ applies: 'yes' }).success).toBe(false);
  });
  it('validates responder pass sentinel', () => {
    expect(ResponderPassSchema.safeParse('[PASS]').success).toBe(true);
    expect(ResponderPassSchema.safeParse('other').success).toBe(false);
  });
});
