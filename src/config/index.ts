import { z } from 'zod';
import { CredentialRequestPatternsSchema } from './output-policy.js';
import { MAX_DELIBERATOR_NOMINATIONS, MAX_RESEARCH_REQUESTS_PER_INPUT } from '../contract/roles.js';

// Each numeric call lists its explicit maximum as the second argument.
const int = (defaultValue: number, maximum: number) => z.number().int().positive().max(maximum).default(defaultValue);
const number = (defaultValue: number, maximum: number) => z.number().positive().max(maximum).default(defaultValue);

const textLexicon = () => z.string().min(1);

export const ConfigSchema = z.strictObject({
  configVersion: z.string().min(1).default('0.3.4'),
  credentialRequestPatterns: CredentialRequestPatternsSchema,
  hedgeLexicon: z.array(textLexicon()).default([
    'might', 'maybe', 'perhaps', 'thinking about', 'I was thinking', 'not sure', 'possibly',
  ]),
  negationLexicon: z.array(textLexicon()).default([
    'not', 'no', 'never', "don't", "doesn't", "isn't", "won't", "can't",
  ]),

  // §5.3, §8.1: short turn coordination; 5 s avoids stalled conversations.
  replyDebounceMs: int(800, 5000), // Avoid a sluggish text reply.
  voiceGraceMs: int(300, 5000), // Avoid a sluggish voice reply.
  interpreterSoftWaitMs: int(600, 5000), // Bound waiting for interpretation.
  // Failure detection: Checker must remain quick; longer role deadlines remain bounded.
  firstTokenTimeoutMs: int(8000, 60000), // Bound waiting for initial output.
  streamStallMs: int(5000, 60000), // Bound mid-stream silence.
  callDeadlineMs: int(20000, 120000), // Bound an entire reply.
  interpreterTimeoutMs: int(15000, 60000), // Bound interpretation latency.
  deliberatorTimeoutMs: int(30000, 60000), // Bound background reasoning.
  checkerTimeoutMs: int(2500, 10000), // Protect delivery responsiveness.
  // Floor timers remain responsive; explicit user waits are allowed up to two minutes.
  waitExpiryMs: int(4000, 30000), // Avoid a stuck provisional voice turn.
  answerWaitMs: int(20000, 120000), // Bound floor reservation after a question.
  userWaitMs: int(20000, 120000), // Bound a requested pause.
  gapTextMs: int(3000, 30000), // Avoid excessive text-floor delay.
  gapVoiceMs: int(1200, 30000), // Avoid excessive voice-floor delay.

  // §8.2: bounded research, admission and privacy for one laptop.
  publicQueryMaxChars: int(200, 2000), // Avoid oversized public queries.
  privateTermBlocklist: z.array(z.string().min(1)).default([]),
  defaultResearchScopeCategories: z.array(z.enum([
    'public_technical_documentation',
    'pricing_and_limits',
    'licences',
    'existing_alternatives',
  ])).default(['public_technical_documentation', 'pricing_and_limits', 'licences', 'existing_alternatives']),
  jobsMaxConcurrent: int(2, 4), // Four workers protect a single laptop.
  jobsMaxQueued: int(4, 16), // A small queue limits backlog.
  jobsMaxPerSession: int(15, 50), // Bound session research volume.
  jobDeadlineMs: int(90000, 300000), // Five minutes bounds unattended research.
  jobMaxRetries: int(1, 3), // Limit repeated network work.
  maxToolCallsPerSearch: int(3, 6), // Tool calls are distinct from actual queries.
  maxEvidenceResults: int(20, 100), // Bound journal growth.
  maxSnippetChars: int(2000, 10000), // Bound each retained snippet.
  maxResearchRequestsPerInput: int(3, MAX_RESEARCH_REQUESTS_PER_INPUT), // Contract ceiling.
  autoAdmitMinConsequenceScore: int(2, 3), // Score scale is 0–3.
  autoAdmitMinUncertaintyScore: int(2, 3), // Score scale is 0–3.
  askMinConsequenceScore: int(1, 3), // Score scale is 0–3.

  // §8.3: pacing and bounded arbitration.
  speakSpacingMs: int(45000, 600000), // At most ten minutes between updates.
  candidateExpiryMs: int(300000, 1800000), // At most thirty minutes of floor-available time.
  blockerWindowMs: int(300000, 1800000), // Keep rate windows bounded.
  maxBlockersPerGap: int(1, 4), // Keep interruptions limited.
  maxBlockersPerWindow: int(2, 10), // Keep blockers bounded per window.
  maxCheckerSentences: int(2, 4), // Spoken contributions stay short.
  maxContributionsAfterResume: int(1, 3), // Avoid a backlog of spoken updates.
  maxCandidateInterruptions: int(2, 4), // Bound retry after interruption.
  maxCheckerRechecks: int(1, 3), // Bound checker work.
  maxPatchConflictReinterpretations: int(1, 3), // Bound patch retries.
  maxReplyReplays: int(1, 3), // Bound reply regeneration.

  // §8.4: spend and model limits; limits protect the hackathon grant.
  sessionSoftCapUsd: number(3, 20), // Bound research spend per session.
  sessionHardCapUsd: number(5, 25), // Bound total session spend.
  developmentDailyCapUsd: number(10, 50), // Bound daily development spend.
  judgingReserveUsd: number(40, 150), // Never exceed the nominal grant.
  searchUsdPerThousandQueries: number(2.5, 100), // Reject implausible unit prices.
  assumedQueriesPerToolCall: int(3, 20), // Bound conservative accounting.
  transcriptionUsdPerHour: number(0.18, 10), // Reject implausible unit prices.
  deliberationDebounceMs: int(2000, 5000), // Avoid delayed background decisions.
  maxDeliberatorRunsPerInput: int(3, 10), // Bound repeated reasoning.
  maxDeliberatorRunsPerMinute: int(4, 20), // Bound rate and cost.
  maxDeliberatorNominations: int(3, MAX_DELIBERATOR_NOMINATIONS), // Contract ceiling.
  interpreterMaxOutputTokens: int(1200, 4800), // At most four times default.
  responderMaxOutputTokens: int(800, 3200), // At most four times default.
  deliberatorMaxOutputTokens: int(3000, 12000), // At most four times default.
  investigatorSearchMaxOutputTokens: int(4000, 16000), // Four times default; max 16k.
  investigatorStructureMaxOutputTokens: int(1500, 6000), // At most four times default.
  checkerMaxOutputTokens: int(600, 2400), // At most four times default.

  // §10: voice wire constraints; bounded to plausible browser audio settings.
  voiceSampleRateHz: int(24000, 96000), // Accommodate common device rates.
  voiceFrameMinMs: int(40, 500), // Prevent excessive frame latency.
  voiceFrameMaxMs: int(80, 500), // Prevent excessive frame latency.
  sttHandshakeTimeoutMs: int(10000, 60000), // Bound connection setup.
  sttMaxAheadMs: int(5000, 30000), // Bound relay buffering.
  sttSessionMaxMs: int(3600000, 7200000), // Bound one relay session.
  backchannelMaxWords: int(3, 10), // Backchannels remain brief.
  backchannelLexicon: z.array(z.string().min(1)).default(['yeah', 'mm-hmm', 'right', 'ok', 'uh-huh']),

  // §12: recovery and bounded retries.
  deliveryAckMs: int(1500, 10000), // Bound waiting for playback acknowledgement.
  responderMaxRetries: int(1, 3), // Avoid repeated provider calls.
  interpreterRepairAttempts: int(1, 3), // Bound format repair.
  structuredRetryAttempts: int(1, 3), // Bound structured retries.
  structuredRetryTokenMultiplier: z.number().gt(1).max(4).default(1.5), // Higher retry cap, limited to four times.
}).refine(c => c.sessionSoftCapUsd < c.sessionHardCapUsd, { message: 'soft cap must be less than hard cap' })
  .refine(c => c.sessionHardCapUsd <= c.developmentDailyCapUsd, { message: 'hard cap exceeds daily cap' })
  .refine(c => c.voiceFrameMinMs <= c.voiceFrameMaxMs, { message: 'voice frame range is reversed' });

export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse(overrides);
}
