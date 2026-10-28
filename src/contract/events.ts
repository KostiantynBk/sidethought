import { z } from 'zod';
import {
  count,
  id,
  text,
  DepSchema,
  EnvelopeFields,
  FindingSchema,
  ItemSchema,
  RetrievalEvidenceSchema,
  retrievalEvidenceSchemaWithLimits,
} from './models.js';
import {
  InterpreterOutputSchema,
  DeliberatorOutputSchema,
  CheckerOutputSchema,
  InvestigatorOutputSchema,
} from './roles.js';

// provisional: confirm in T05/T06
// Event payloads, project.loaded, delivery.progress.reason, and client messages are provisional.
const event = <T extends string, S extends z.ZodType>(type: T, payload: S) =>
  z.strictObject({
    ...EnvelopeFields,
    type: z.literal(type),
    payload,
  });
const obj = z.strictObject;
const call = {
  requestId: id,
  callId: id,
};
const failed = obj({
  ...call,
  reason: text,
});
const job = {
  jobId: id,
  callId: id,
};
export const TimerPurposeSchema = z.enum([
  'replyDebounce',
  'interpreterSoftWait',
  'firstTokenTimeout',
  'streamStall',
  'callDeadline',
  'floorGap',
  'rateLimit',
  'answerWait',
  'userWait',
  'candidateExpiry',
  'checkTimeout',
  'deliberationDebounce',
  'jobDeadline',
  'waitExpiry',
  'voiceGrace',
  'deliveryAck',
]);
// Only provisional deltas and activity pings may be lost between durable events (§6.3).
export const TELEMETRY_EVENT_TYPES = ['reply.chunk', 'voice.partial', 'voice.activity', 'input.activity'] as const;

export const EventSchema = z.discriminatedUnion('type', [
  // provisional: confirm in T07
  event(
    'client.connected',
    obj({
      modality: z.enum(['text', 'voice']),
    }),
  ),
  event('client.disconnected', obj({})),
  event(
    'input.committed',
    obj({
      clientMsgId: id,
      text: z.string(),
      modality: z.enum(['text', 'voice']),
      utteranceId: id.optional(),
      renderedUpTo: count.optional(),
    }),
  ),
  // provisional: confirm in T07; retries are durable user actions.
  event('input.retry', obj({ inputIds: z.array(id) })),
  event(
    'input.activity',
    obj({
      channel: z.enum(['composer', 'localVoice']),
      active: z.boolean(),
    }),
  ),
  event('voice.partial', obj({ text: z.string() })),
  event(
    'voice.activity',
    obj({
      turnId: id,
      active: z.boolean(),
    }),
  ),
  event(
    'control.set',
    obj({
      action: z.enum([
        'hold',
        'resume',
        'stopResearch',
        'resumeResearch',
        'privateOn',
        'privateOff',
        'mute',
        'unmute',
        'endSession',
        'deleteSession',
      ]),
    }),
  ),
  event('scope.set', obj({ categories: z.array(text) })),
  event(
    'item.action',
    z.discriminatedUnion('action', [
      obj({
        itemId: id,
        expectedVersion: count,
        action: z.enum(['confirm', 'reject', 'delete']),
      }),
      obj({
        itemId: id,
        expectedVersion: count,
        action: z.literal('edit'),
        text,
      }),
    ]),
  ),
  event('job.approve', obj({ jobId: id })),
  event('job.decline', obj({ jobId: id })),
  event('job.cancelRequested', obj({ jobId: id })),
  event('job.retry', obj({ jobId: id })),
  event('finding.dismissed', obj({ findingId: id })),
  event('finding.markedWrong', obj({ findingId: id })),
  event(
    'delivery.progress',
    obj({
      deliveryId: id,
      chunkIdx: count,
      chars: count,
      final: z.boolean(),
      reason: z.string(),
    }),
  ),
  event(
    'interpretation.ready',
    obj({
      ...call,
      output: InterpreterOutputSchema,
    }),
  ),
  event('interpretation.failed', failed),
  event(
    'reply.chunk',
    obj({
      ...call,
      text: z.string(),
    }),
  ),
  event('reply.done', obj({ ...call })),
  event('reply.failed', failed),
  event(
    'deliberation.ready',
    obj({
      ...call,
      output: DeliberatorOutputSchema,
    }),
  ),
  event('deliberation.failed', failed),
  event('job.started', obj(job)),
  event(
    'job.completed',
    obj({
      ...job,
      investigatorOutput: InvestigatorOutputSchema,
      retrievalEvidence: RetrievalEvidenceSchema,
    }),
  ),
  event(
    'job.failed',
    obj({
      ...job,
      reason: text,
    }),
  ),
  event('job.timedOut', obj(job)),
  event('job.cancelled', obj(job)),
  event(
    'check.ready',
    obj({
      ...call,
      output: CheckerOutputSchema,
    }),
  ),
  event('check.failed', failed),
  event(
    'llm.usage',
    obj({
      callId: id,
      inputTokens: count,
      outputTokens: count,
      queries: count,
      audioSeconds: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  ),
  event(
    'timer.fired',
    obj({
      purpose: TimerPurposeSchema,
      timerId: id,
    }),
  ),
  event(
    'budget.global',
    obj({
      spentTodayUsd: z.number().nonnegative(),
      reservedUsd: z.number().nonnegative(),
      reserveUsd: z.number().nonnegative(),
    }),
  ),
  event(
    'project.loaded',
    obj({
      state: obj({
        items: z.array(ItemSchema),
        projectRev: count,
      }),
    }),
  ),
  event('session.recovered', obj({})),
]);
// Kernel entry points use this configured validator; the base union validates wire shape.
export function eventSchemaWithEvidenceLimits(limits: { maxEvidenceResults: number; maxSnippetChars: number }) {
  const evidenceSchema = retrievalEvidenceSchemaWithLimits(limits);
  return EventSchema.superRefine((event, ctx) => {
    if (event.type !== 'job.completed') return;
    const result = evidenceSchema.safeParse(event.payload.retrievalEvidence);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'retrievalEvidence', ...issue.path],
          message: issue.message,
        });
      }
    }
  });
}
export const ClientMessageSchema = z.discriminatedUnion('type', [
  obj({
    type: z.literal('ui.snapshot'),
    state: z.unknown(),
  }),
  obj({
    type: z.literal('transcript.appended'),
    text: z.string(),
  }),
  obj({
    type: z.literal('assistant.chunk'),
    deliveryId: id,
    chunkIdx: count,
    text: z.string(),
  }),
  obj({
    type: z.literal('assistant.stopped'),
    deliveryId: id,
    reason: text,
  }),
  obj({
    type: z.literal('project.changed'),
    projectRev: count,
    items: z.array(ItemSchema),
  }),
  obj({
    type: z.literal('job.updated'),
    jobId: id,
    publicQuery: text,
    state: text,
  }),
  obj({
    type: z.literal('finding.upserted'),
    finding: FindingSchema,
  }),
  obj({
    type: z.literal('budget.updated'),
    spentUsd: z.number().nonnegative(),
    reservedUsd: z.number().nonnegative(),
  }),
  obj({
    type: z.literal('inspector.decision'),
    reason: text,
  }),
]);
export const EffectSchema = z.discriminatedUnion('type', [
  obj({
    type: z.literal('llm.call'),
    role: z.enum(['interpreter', 'responder', 'deliberator', 'investigatorSearch', 'investigatorStructure', 'checker']),
    requestId: id,
    callId: id,
    basisRev: count,
    capturedInputs: z.array(DepSchema),
  }),
  obj({
    type: z.literal('llm.abort'),
    callId: id,
  }),
  obj({
    type: z.literal('job.dispatch'),
    jobId: id,
    callId: id,
    capturedInputs: z.array(DepSchema),
  }),
  obj({
    type: z.literal('job.abort'),
    callId: id,
  }),
  obj({
    type: z.literal('timer.set'),
    timerId: id,
    purpose: TimerPurposeSchema,
    dueAt: count,
  }),
  obj({
    type: z.literal('timer.clear'),
    timerId: id,
  }),
  obj({
    type: z.literal('client.send'),
    message: ClientMessageSchema,
  }),
  obj({
    type: z.literal('audio.stop'),
    deliveryId: id,
  }),
]);
export type KernelEvent = z.infer<typeof EventSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
