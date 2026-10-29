import { z } from 'zod';

const id = z.string().min(1);
const count = z.number().int().nonnegative();
const text = z.string().min(1);
export const DepSchema = z.strictObject({
  itemId: id,
  contentVersion: count,
});
export const QuoteSpanSchema = z
  .strictObject({
    inputId: id,
    start: count,
    end: count,
    quote: text,
  })
  .refine((s) => s.end > s.start, 'end must follow start');
export const ItemKindSchema = z.enum([
  'requirement',
  'assumption',
  'option',
  'decision',
  'open_question',
  'risk',
  'name',
]);
export const ItemStatusSchema = z.enum([
  'stated',
  'considering',
  'proposed',
  'confirmed',
  'superseded',
  'retracted',
  'rejected',
]);
export const ItemSchema = z.strictObject({
  id,
  kind: ItemKindSchema,
  status: ItemStatusSchema,
  text,
  contentVersion: count,
  private: z.boolean(),
  provenance: z.strictObject({
    origin: z.enum(['user', 'assistant']),
    quoteSpans: z.array(QuoteSpanSchema),
  }),
  voiceConfirmNeeded: z.boolean(),
  verbalConfirmPending: z.boolean().optional(),
});
export const RebaseSchema = z.strictObject({
  atRev: count,
  checkerCallId: id,
  from: z.array(DepSchema),
  to: z.array(DepSchema),
});
export const ValiditySchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('current') }),
  z.strictObject({
    state: z.literal('needs_recheck'),
    editedItemIds: z.array(id),
  }),
  z.strictObject({
    state: z.literal('stale'),
    atRev: count,
    reason: text,
  }),
  z.strictObject({ state: z.literal('withdrawn') }),
]);
export const SupportSchema = z.strictObject({
  url: z.string().url(),
  title: text.optional(),
  quote: text.optional(),
  quoteVerified: z.boolean(),
  published: text.optional(),
  sourceKind: z.enum(['official', 'vendor', 'third_party', 'community']),
});
export const ClaimSchema = z.strictObject({
  text,
  support: z.array(SupportSchema),
  corroboratedBy: z.array(id),
});
export const FindingBodySchema = z.strictObject({
  verdict: z.enum(['supported', 'contradicted', 'mixed', 'inconclusive', 'not_researched']),
  claims: z.array(ClaimSchema),
  caveats: z.array(z.string()),
});
export const RetrievalEvidenceSchema = z.strictObject({
  completedSearchCalls: count,
  issuedQueries: z.array(text),
  results: z.array(
    z.strictObject({
      url: z.string().url(),
      title: text.optional(),
      snippet: z.string(),
    }),
  ),
});
// The consumer applies the configured bounds before accepting the evidence as a kernel event.
export function retrievalEvidenceSchemaWithLimits(limits: { maxEvidenceResults: number; maxSnippetChars: number }) {
  return RetrievalEvidenceSchema.superRefine((evidence, ctx) => {
    if (evidence.results.length > limits.maxEvidenceResults) {
      ctx.addIssue({
        code: 'custom',
        path: ['results'],
        message: 'too many evidence results',
      });
    }
    evidence.results.forEach((result, index) => {
      if (result.snippet.length > limits.maxSnippetChars) {
        ctx.addIssue({
          code: 'custom',
          path: ['results', index, 'snippet'],
          message: 'snippet exceeds configured limit',
        });
      }
    });
  });
}
const dependencies = {
  inputDeps: z.array(DepSchema).readonly(),
  deps: z.array(DepSchema),
  rebases: z.array(RebaseSchema),
};
export const FindingSchema = FindingBodySchema.extend({
  id,
  jobId: id,
  questionKey: id,
  retrievedAt: count,
  basisRev: count,
  ...dependencies,
  validity: ValiditySchema,
  retrievalEvidence: RetrievalEvidenceSchema,
}).refine((f) => f.retrievalEvidence.completedSearchCalls > 0 || f.verdict === 'not_researched', {
  message: 'a finding without a completed search must be not_researched',
});
export const CandidateSchema = z.strictObject({
  id,
  class: z.enum(['blocker', 'speak', 'card']),
  payload: z.enum(['evidence', 'inference', 'clarification', 'closure']),
  source: z.strictObject({
    findingId: id.optional(),
    insightId: id.optional(),
    clarification: text.optional(),
    correctionOfDeliveryId: id.optional(),
  }),
  ...dependencies,
  basisRev: count,
  topicKey: id,
  causalDepth: count,
  promised: z.boolean(),
  checkedAtRev: count.optional(),
  interruptions: count,
  deliveredPrefix: z.string().optional(),
  expiresAt: count.optional(),
});
export const JobStateSchema = z.enum([
  'proposed',
  'rejected',
  'awaiting_user',
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
]);
export const JobSchema = z.strictObject({
  id,
  state: JobStateSchema,
  question: text,
  questionKey: id,
  publicQuery: text,
  whyItMatters: text,
  origin: z.enum(['user_request', 'deliberator']),
  promised: z.boolean(),
  causalDepth: count,
  deps: z.array(DepSchema),
  basisRev: count,
  researchEpoch: count,
  attempt: count,
  callId: id.optional(),
  providerResponseId: id.optional(),
  cancelRequested: z.boolean(),
  deadlineAt: count.optional(),
  queriesCounted: count,
  costUsd: z.number().nonnegative(),
});
export const DeliveryStateSchema = z.enum([
  'candidate',
  'dropped',
  'card_only',
  'checking',
  'delivering',
  'delivered',
  'interrupted',
  'superseded',
]);
export const ChunkSchema = z.strictObject({
  text: z.string(),
  state: z.enum(['pending', 'sent', 'rendered', 'played', 'discarded']),
  claimIds: z.array(id),
  sentenceFinished: z.boolean(),
});
export const DeliverySchema = z.strictObject({
  id,
  candidateId: id.optional(),
  callId: id,
  basisRev: count,
  state: DeliveryStateSchema,
  chunks: z.array(ChunkSchema),
  deliveredChars: count,
  sentChars: count,
  finalAcknowledged: z.boolean(),
  aborted: z.boolean(),
  interruptedPrefix: z.string().optional(),
  claimsDelivered: z.array(id),
});
export const ReplyGenerationSchema = z.strictObject({
  requestId: id,
  callId: id,
  attempt: count,
  inputIds: z.array(id),
  basisRev: count,
  capturedInputs: z.array(DepSchema),
  deliveryId: id,
  overridesSnapshotInputIds: z.array(id),
  buffer: z.string(),
  status: z.enum(['streaming', 'done', 'failed', 'interrupted', 'aborted']),
});
export type ReplyGeneration = z.infer<typeof ReplyGenerationSchema>;
export const KernelIdSchema = z.string().regex(/^[^.]+\.\d+\.\d+$/);
export function kernelId(sessionId: string, seq: number, n: number): string {
  if (!/^[^.]+$/.test(sessionId) || !Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(n) || n < 0) {
    throw new Error('invalid kernel ID components');
  }
  return `${sessionId}.${seq}.${n}`;
}
export type Dep = z.infer<typeof DepSchema>;
export type QuoteSpan = z.infer<typeof QuoteSpanSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type RetrievalEvidence = z.infer<typeof RetrievalEvidenceSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;
export interface Envelope<T extends string, P> {
  eventId: string;
  sessionId: string;
  type: T;
  causalParent?: string;
  observedAt?: number;
  seq?: number;
  acceptedAt?: number;
  payload: P;
}
export const EnvelopeFields = {
  eventId: id,
  sessionId: id,
  causalParent: id.optional(),
  observedAt: count.optional(),
  seq: count.optional(),
  acceptedAt: count.optional(),
};
export { id, count, text };
