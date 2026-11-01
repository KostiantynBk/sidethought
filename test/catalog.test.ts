import { describe, it, expect } from 'vitest';
import { EventSchema, EffectSchema, ClientMessageSchema } from '../src/contract/index.js';
import { ConfigSchema, loadConfig } from '../src/config/index.js';
const item = {
  id: 'i',
  kind: 'requirement',
  status: 'stated',
  text: 'x',
  contentVersion: 1,
  private: false,
  provenance: {
    origin: 'user',
    quoteSpans: [],
  },
  voiceConfirmNeeded: false,
};
const retrievalEvidence = {
  completedSearchCalls: 1,
  issuedQueries: ['q'],
  results: [
    {
      url: 'https://example.com',
      snippet: 'text',
    },
  ],
};
const finding = {
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
  retrievalEvidence,
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
const call = {
  requestId: 'r',
  callId: 'c',
};
const job = {
  jobId: 'j',
  callId: 'c',
};
const events: Record<string, unknown> = {
  'client.connected': { modality: 'text' },
  'client.disconnected': {},
  'input.committed': {
    clientMsgId: 'm',
    text: 'hello',
    modality: 'text',
  },
  'input.retry': {
    inputIds: ['i'],
  },
  'input.activity': {
    channel: 'composer',
    active: true,
  },
  'voice.partial': { text: 'x' },
  'voice.activity': {
    turnId: 't',
    active: true,
  },
  'control.set': { action: 'hold' },
  'scope.set': { categories: [] },
  'item.action': {
    itemId: 'i',
    expectedVersion: 1,
    action: 'confirm',
  },
  'job.approve': { jobId: 'j' },
  'job.decline': { jobId: 'j' },
  'job.cancelRequested': { jobId: 'j' },
  'job.retry': { jobId: 'j' },
  'finding.dismissed': { findingId: 'f' },
  'finding.markedWrong': { findingId: 'f' },
  'delivery.progress': {
    deliveryId: 'd',
    chunkIdx: 0,
    chars: 1,
    final: true,
    reason: 'rendered',
  },
  'interpretation.ready': {
    ...call,
    output: interpreter,
  },
  'interpretation.failed': {
    ...call,
    reason: 'bad',
  },
  'reply.chunk': {
    ...call,
    text: 'x',
  },
  'reply.done': call,
  'reply.failed': {
    ...call,
    reason: 'bad',
  },
  'deliberation.ready': {
    ...call,
    output: { nominations: [] },
  },
  'deliberation.failed': {
    ...call,
    reason: 'bad',
  },
  'job.started': job,
  'job.completed': {
    ...job,
    investigatorOutput: {
      verdict: 'inconclusive',
      claims: [],
      caveats: [],
    },
    retrievalEvidence,
  },
  'job.failed': {
    ...job,
    reason: 'bad',
  },
  'job.timedOut': job,
  'job.cancelled': job,
  'check.ready': {
    ...call,
    output: {
      applies: true,
      reason: 'ok',
      utterance: 'x',
      claimsUsed: [],
    },
  },
  'check.failed': {
    ...call,
    reason: 'bad',
  },
  'llm.usage': {
    callId: 'c',
    inputTokens: 0,
    outputTokens: 0,
    queries: 0,
    audioSeconds: 0,
    costUsd: 0,
  },
  'timer.fired': {
    purpose: 'userWait',
    timerId: 't',
  },
  'budget.global': {
    spentTodayUsd: 0,
    reservedUsd: 0,
    reserveUsd: 40,
  },
  'project.loaded': {
    state: {
      items: [item],
      projectRev: 1,
    },
  },
  'session.recovered': {},
};
const clients: Record<string, object> = {
  'ui.snapshot': { state: {} },
  'transcript.appended': { text: 'x' },
  'assistant.chunk': {
    deliveryId: 'd',
    chunkIdx: 0,
    text: 'x',
  },
  'assistant.done': {
    deliveryId: 'd',
    chunkCount: 1,
  },
  'assistant.stopped': {
    deliveryId: 'd',
    reason: 'stop',
  },
  'project.changed': {
    projectRev: 1,
    items: [item],
  },
  'job.updated': {
    jobId: 'j',
    publicQuery: 'query',
    state: 'queued',
  },
  'finding.upserted': { finding },
  'contribution.upserted': {
    candidateId: 'candidate',
    class: 'card',
    payload: 'inference',
    state: 'card_only',
    topic: 'topic',
    text: 'insight',
  },
  'budget.updated': {
    spentUsd: 0,
    reservedUsd: 0,
  },
  'inspector.decision': { reason: 'x' },
};
const effects: Record<string, object> = {
  'llm.call': {
    role: 'interpreter',
    requestId: 'r',
    callId: 'c',
    basisRev: 0,
    capturedInputs: [],
  },
  'llm.abort': { callId: 'c' },
  'job.dispatch': {
    jobId: 'j',
    callId: 'c',
    capturedInputs: [],
  },
  'job.abort': { callId: 'c' },
  'timer.set': {
    timerId: 't',
    purpose: 'floorGap',
    dueAt: 1,
  },
  'timer.clear': { timerId: 't' },
  'client.send': {
    message: {
      type: 'transcript.appended',
      text: 'x',
    },
  },
  'audio.stop': { deliveryId: 'd' },
};
describe('complete wire catalog', () => {
  it.each(Object.entries(events))('parses event %s', (type, payload) =>
    expect(
      EventSchema.safeParse({
        eventId: 'e',
        sessionId: 's',
        type,
        payload,
      }).success,
    ).toBe(true),
  );
  it.each(Object.entries(clients))('parses client message %s', (type, payload) =>
    expect(
      ClientMessageSchema.safeParse({
        type,
        ...payload,
      }).success,
    ).toBe(true),
  );
  it.each(Object.entries(effects))('parses effect %s', (type, payload) =>
    expect(
      EffectSchema.safeParse({
        type,
        ...payload,
      }).success,
    ).toBe(true),
  );
  it('the samples cover each union option', () => {
    const types = (options: readonly { shape: { type: { value: string } } }[]) =>
      options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(events).sort()).toEqual(types(EventSchema.options));
    expect(Object.keys(clients).sort()).toEqual(types(ClientMessageSchema.options));
    expect(Object.keys(effects).sort()).toEqual(types(EffectSchema.options));
  });
});
describe('every numeric config bound', () => {
  it('permits disabling research retries but caps them at one', () => {
    expect(loadConfig({ jobMaxRetries: 0 }).jobMaxRetries).toBe(0);
    expect(loadConfig({ jobMaxRetries: 1 }).jobMaxRetries).toBe(1);
    expect(() => loadConfig({ jobMaxRetries: -1 })).toThrow();
    expect(() => loadConfig({ jobMaxRetries: 2 })).toThrow();
    expect(() => loadConfig({ jobMaxRetries: 0.5 })).toThrow();
  });

  const defaults = loadConfig();
  const numeric = Object.entries(defaults).filter(([key, v]) => typeof v === 'number' && key !== 'jobMaxRetries');
  it.each(numeric)('%s rejects zero, negative and above its maximum', (key) => {
    const field = ConfigSchema.shape[key as keyof typeof ConfigSchema.shape];
    const inner = field._def.innerType as { maxValue?: number };
    expect(typeof inner.maxValue).toBe('number');
    for (const value of [0, -1, inner.maxValue! + 1])
      expect(ConfigSchema.safeParse({ [key]: value }).success).toBe(false);
  });
});
