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

describe('events', () => {
  const examples = [
    event('input.committed', {
      clientMsgId: 'm',
      text: 'hi',
      modality: 'text',
    }),
    event('interpretation.ready', {
      requestId: 'r',
      callId: 'c',
      output: interpreter,
    }),
    event('timer.fired', {
      purpose: 'userWait',
      timerId: 't',
    }),
    event('budget.global', {
      spentTodayUsd: 0,
      reservedUsd: 0,
      reserveUsd: 40,
    }),
  ];
  for (const sample of examples) {
    it(`validates ${sample.type} and rejects invalid payload`, () => {
      expect(EventSchema.safeParse(sample).success).toBe(true);
      expect(
        EventSchema.safeParse({
          ...sample,
          payload: { invalid: true },
        }).success,
      ).toBe(false);
    });
  }
  it('covers every timer purpose', () => {
    for (const purpose of TimerPurposeSchema.options) {
      expect(
        EventSchema.safeParse(
          event('timer.fired', {
            purpose,
            timerId: 't',
          }),
        ).success,
      ).toBe(true);
    }
  });
  it('accepts recovery', () => {
    expect(EventSchema.safeParse(event('session.recovered', {})).success).toBe(true);
  });
  it('accepts item edits', () => {
    expect(
      EventSchema.safeParse(
        event('item.action', {
          itemId: 'i',
          expectedVersion: 1,
          action: 'edit',
          text: 'x',
        }),
      ).success,
    ).toBe(true);
  });
  it('requires call identity and captured inputs', () => {
    const value = {
      type: 'llm.call',
      role: 'interpreter',
      requestId: 'r',
      callId: 'c',
      basisRev: 0,
      capturedInputs: [],
    };
    expect(EffectSchema.safeParse(value).success).toBe(true);
    for (const key of ['callId', 'requestId', 'capturedInputs']) {
      const partial = { ...value };
      delete partial[key as keyof typeof partial];
      expect(EffectSchema.safeParse(partial).success).toBe(false);
    }
  });
});
describe('config and IDs', () => {
  it('parses config defaults', () => {
    expect(ConfigSchema.safeParse({}).success).toBe(true);
  });
  it('rejects a zero gap', () => {
    expect(ConfigSchema.safeParse({ gapTextMs: 0 }).success).toBe(false);
  });
  it('rejects a negative gap', () => {
    expect(ConfigSchema.safeParse({ gapTextMs: -1 }).success).toBe(false);
  });
  it('rejects an excessively large gap', () => {
    expect(ConfigSchema.safeParse({ gapTextMs: 3600001 }).success).toBe(false);
  });
  it('rejects unknown config keys', () => {
    expect(ConfigSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });
  it('ignores environment and applies explicit overrides', () => {
    const old = process.env.GAP_TEXT_MS;
    try {
      process.env.GAP_TEXT_MS = '10';
      expect(loadConfig().gapTextMs).toBe(3000);
      expect(loadConfig({ gapTextMs: 42 }).gapTextMs).toBe(42);
    } finally {
      if (old === undefined) delete process.env.GAP_TEXT_MS;
      else process.env.GAP_TEXT_MS = old;
    }
  });
  it('produces and validates deterministic IDs', () => {
    expect(kernelId('s', 2, 3)).toBe('s.2.3');
    expect(KernelIdSchema.safeParse(kernelId('s', 2, 3)).success).toBe(true);
    expect(KernelIdSchema.safeParse('s.x.3').success).toBe(false);
    expect(() => kernelId('s', -1, 1)).toThrow();
  });
});
