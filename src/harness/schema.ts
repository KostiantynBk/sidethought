import { z } from 'zod';
import {
  DepSchema,
  DeliverySchema,
  EffectSchema,
  ItemSchema,
  ReplyGenerationSchema,
  TimerPurposeSchema,
} from '../contract/index.js';

export const fakeSchema = z.strictObject({
  role: z.string().min(1),
  offset: z.number().int().positive(),
  type: z.string().min(1),
  output: z.unknown().optional(),
  reason: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type Fake = z.infer<typeof fakeSchema>;
type Identity = {
  requestId: string;
  callId: string;
  jobId: string;
};

export function fakePayload(fake: Fake, identity: Identity): object {
  if (fake.type === 'interpretation.ready') {
    return {
      requestId: identity.requestId,
      callId: identity.callId,
      output: fake.output,
    };
  }
  if (fake.type === 'interpretation.failed') {
    return {
      requestId: identity.requestId,
      callId: identity.callId,
      reason: fake.reason,
    };
  }
  const ids = fake.type.startsWith('job.')
    ? {
      jobId: identity.jobId,
      callId: identity.callId,
    }
    : {
      requestId: identity.requestId,
      callId: identity.callId,
    };
  return {
    ...fake.payload,
    ...ids,
  };
}

const decisionSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  kind: z.string(),
  reason: z.string(),
});
const timerSchema = z.strictObject({
  timerId: z.string(),
  purpose: TimerPurposeSchema,
  dueAt: z.number().int().nonnegative(),
});
const callSchema = z.strictObject({
  requestId: z.string(),
  callId: z.string(),
  attempt: z.number().int().positive(),
  inputIds: z.array(z.string()),
  basisRev: z.number().int().nonnegative(),
  capturedInputs: z.array(DepSchema),
});
const inputSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  status: z.enum(['waiting', 'inflight', 'interpreted', 'needs_retry']),
  origin: z.enum(['user', 'assistant']).optional(),
  modality: z.enum(['text', 'voice']).optional(),
  conflicts: z.number().int().nonnegative().optional(),
  floorEpoch: z.number().int().nonnegative().optional(),
  kind: z.enum([
    'statement',
    'correction',
    'hypothetical',
    'aside',
    'direct_question',
    'answer',
    'wait',
    'deferral',
    'dismissal',
  ]).optional(),
});
const finalSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  pendingTimers: z.array(timerSchema),
  inFlight: callSchema.nullable(),
  uninterpreted: z.array(inputSchema),
  reservations: z.array(z.string()),
  replyPending: z.boolean(),
  reply: ReplyGenerationSchema.nullable().optional(),
  deliveries: z.record(z.string(), DeliverySchema).optional(),
  replyStartWaiting: z.boolean().optional(),
  project: z.strictObject({
    items: z.array(ItemSchema),
    projectRev: z.number().int().nonnegative(),
  }).optional(),
});
export const fixtureSchema = z.strictObject({
  meta: z.strictObject({
    schemaVersion: z.literal(1),
    reducerVersion: z.literal('5'),
    configVersion: z.literal('0.3.4'),
    fixtureVersion: z.string().min(1),
  }),
  sessionId: z.string().min(1),
  initialState: z.strictObject({
    domain: z.strictObject({
      timers: z.array(timerSchema).optional(),
      inputs: z.array(inputSchema).optional(),
      items: z.record(z.string(), ItemSchema).optional(),
      projectRev: z.number().int().nonnegative().optional(),
      replyPending: z.boolean().optional(),
      composerActive: z.boolean().optional(),
      reply: ReplyGenerationSchema.nullable().optional(),
      deliveries: z.record(z.string(), DeliverySchema).optional(),
      replyStartWaiting: z.boolean().optional(),
      awaitingUserAnswer: z.boolean().optional(),
      userWait: z.boolean().optional(),
      clientConnected: z.boolean().optional(),
      reservations: z.array(z.string()).optional(),
    }),
  }).optional(),
  faults: z.array(z.strictObject({
    afterSeq: z.number().int().positive(),
    kind: z.literal('sinkThrows'),
  })).optional(),
  generate: z.strictObject({
    repeatCommits: z.number().int().positive().max(10000),
  }).optional(),
  assertions: z.strictObject({
    decisionCount: z.number().int().nonnegative(),
    lastDecision: z.string(),
    finalSeq: z.number().int().nonnegative(),
  }).optional(),
  events: z.array(z.strictObject({
    at: z.number().int().nonnegative(),
    event: z.unknown(),
  })),
  fakes: z.array(fakeSchema),
  endAt: z.number().int().nonnegative(),
  drain: z.boolean().optional(),
  expected: z.strictObject({
    decisions: z.array(decisionSchema),
    effects: z.array(EffectSchema),
    final: finalSchema,
  }),
});
export type Fixture = z.infer<typeof fixtureSchema>;
