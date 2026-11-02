import { z } from 'zod';
import { count, id, text, QuoteSpanSchema, ItemKindSchema, ItemStatusSchema } from './models.js';

export const MAX_RESEARCH_REQUESTS_PER_INPUT = 3;
export const MAX_DELIBERATOR_NOMINATIONS = 3;
const proposalFields = {
  kind: ItemKindSchema,
  status: ItemStatusSchema.exclude(['confirmed']),
  text,
  quoteSpans: z.array(QuoteSpanSchema),
};
export const PatchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('create'),
    localRef: id.optional(),
    ...proposalFields,
  }),
  z.strictObject({
    op: z.literal('update'),
    itemId: id,
    ...proposalFields,
  }),
  z.strictObject({
    op: z.literal('supersede'),
    itemId: id,
    quoteSpans: z.array(QuoteSpanSchema),
    replacement: z.strictObject({
      ...proposalFields,
      localRef: id.optional(),
    }),
  }),
  z.strictObject({
    op: z.literal('retract'),
    itemId: id,
    quoteSpans: z.array(QuoteSpanSchema),
  }),
  z.strictObject({
    op: z.literal('reject'),
    itemId: id,
    quoteSpans: z.array(QuoteSpanSchema),
  }),
]);
export const ReplacementGroupSchema = z.strictObject({
  ops: z.array(PatchOpSchema).min(2),
});
// Application binds versions from capturedInputs, never from model output.
export const VersionBoundPatchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('create'),
    localRef: id.optional(),
    ...proposalFields,
  }),
  z.strictObject({
    op: z.literal('update'),
    itemId: id,
    seenContentVersion: count,
    ...proposalFields,
  }),
  z.strictObject({
    op: z.literal('supersede'),
    itemId: id,
    seenContentVersion: count,
    quoteSpans: z.array(QuoteSpanSchema),
    replacement: z.strictObject({
      ...proposalFields,
      localRef: id.optional(),
    }),
  }),
  z.strictObject({
    op: z.literal('retract'),
    itemId: id,
    seenContentVersion: count,
    quoteSpans: z.array(QuoteSpanSchema),
  }),
  z.strictObject({
    op: z.literal('reject'),
    itemId: id,
    seenContentVersion: count,
    quoteSpans: z.array(QuoteSpanSchema),
  }),
]);
export const AppliedPatchBatchSchema = z.strictObject({
  requestId: id,
  callId: id,
  ops: z.array(VersionBoundPatchOpSchema),
  replacementGroups: z.array(z.strictObject({ ops: z.array(VersionBoundPatchOpSchema).min(2) })),
});
export const InterpreterOutputSchema = z
  .strictObject({
    inputKinds: z.array(z.strictObject({
      inputId: id,
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
      ]),
    })),
    ops: z.array(PatchOpSchema),
    replacementGroups: z.array(ReplacementGroupSchema),
    researchRequests: z.array(
      z.strictObject({
        inputId: id,
        question: text,
        publicQuery: text,
        depItemIds: z.array(id),
      }),
    ),
    clarification: text.optional(),
    deprioritizedTopics: z.array(text),
    voiceConfirmValues: z.array(text),
    agreesWith: z.array(id).optional(),
  })
  .superRefine((output, ctx) => {
    const perInput = new Map<string, number>();
    for (const request of output.researchRequests) {
      perInput.set(request.inputId, (perInput.get(request.inputId) ?? 0) + 1);
    }
    for (const [inputId, n] of perInput) {
      if (n > MAX_RESEARCH_REQUESTS_PER_INPUT) {
        ctx.addIssue({
          code: 'custom',
          path: ['researchRequests'],
          message: `too many requests for input ${inputId}`,
        });
      }
    }
  });
export const ResponderPassSchema = z.literal('[PASS]');
const scores = z.strictObject({
  consequence: z.number().int().min(0).max(3),
  uncertainty: z.number().int().min(0).max(3),
  answerable: z.boolean(),
  urgency: z.number().int().min(0).max(2),
  needsPrivateDetail: z.boolean(),
});
const common = {
  topic: text,
  depItemIds: z.array(id),
  scores,
};
export const NominationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('investigation'),
    question: text,
    publicQuery: text,
    lessonIds: z.array(id).optional(),
    ...common,
  }),
  z.strictObject({
    kind: z.literal('insight'),
    insight: text,
    lessonIds: z.array(id).optional(),
    findingIds: z.array(id).optional(),
    ...common,
  }),
  z.strictObject({
    kind: z.literal('clarification'),
    question: text,
    ...common,
  }),
]);
export const DeliberatorOutputSchema = z.strictObject({
  nominations: z.array(NominationSchema).max(MAX_DELIBERATOR_NOMINATIONS),
});
export const InvestigatorOutputSchema = z.strictObject({
  verdict: z.enum(['supported', 'contradicted', 'mixed', 'inconclusive']),
  claims: z.array(
    z.strictObject({
      text,
      support: z.array(
        z.strictObject({
          url: z.string().url(),
          title: text.optional(),
          quote: text,
          published: text.optional(),
          sourceKind: z.enum(['official', 'vendor', 'third_party', 'community']),
        }),
      ),
    }),
  ),
  caveats: z.array(z.string()),
});
export const CheckerOutputSchema = z.strictObject({
  applies: z.boolean(),
  reason: z.string(),
  utterance: z.string(),
  claimsUsed: z.array(id),
});
export type VersionBoundPatchOp = z.infer<typeof VersionBoundPatchOpSchema>;
export type AppliedPatchBatch = z.infer<typeof AppliedPatchBatchSchema>;
export type InterpreterOutput = z.infer<typeof InterpreterOutputSchema>;
export type DeliberatorOutput = z.infer<typeof DeliberatorOutputSchema>;
export type InvestigatorOutput = z.infer<typeof InvestigatorOutputSchema>;
export type CheckerOutput = z.infer<typeof CheckerOutputSchema>;
