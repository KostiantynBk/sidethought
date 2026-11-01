import { expect } from 'vitest';
import { loadConfig, type Config } from '../src/config/index.js';
import { EventSchema, type Effect, type InvestigatorOutput, type Item } from '../src/contract/index.js';
import { initialState, type State } from '../src/kernel/index.js';
import { invariantRegistry } from '../src/harness/invariants.js';
import { REDUCER_VERSION, SessionRunner, type RunnerResult } from '../src/runtime/session-runner.js';
import { MemoryStore, SqliteStore } from '../src/store/index.js';
import { readyOutput } from './t03-helpers.js';

export const url = 'https://provider.example/docs/offline';
export const claims: InvestigatorOutput = {
  verdict: 'mixed',
  claims: [
    {
      text: 'Provider A edits work offline after first sign-in',
      support: [{
        url,
        quote: 'Provider A edits work offline after first sign-in',
        sourceKind: 'official',
        published: '2026-10-01',
      }],
    },
    {
      text: 'First sign-in requires a network',
      support: [{
        url,
        quote: 'First sign-in requires a network',
        sourceKind: 'official',
      }],
    },
    {
      text: 'Provider A supports unlimited backups',
      support: [{
        url,
        quote: 'Provider A supports unlimited backups',
        sourceKind: 'community',
      }],
    },
  ],
  caveats: ['Card-only secondary note'],
};
export const evidence = {
  completedSearchCalls: 1,
  issuedQueries: ['Provider A offline'],
  results: [{
    url,
    snippet: 'Provider A edits work offline after first sign-in. First sign-in requires a network.',
  }],
};

export function item(id = 'r1', text = 'Provider A', privateItem = false): Item {
  return {
    id,
    text,
    kind: 'option',
    status: 'proposed',
    contentVersion: 1,
    private: privateItem,
    provenance: {
      origin: 'assistant',
      quoteSpans: [],
    },
    voiceConfirmNeeded: false,
  };
}

export class ResearchHarness {
  readonly store: MemoryStore | SqliteStore;
  readonly runner: SessionRunner;
  readonly effects: Effect[] = [];
  at = 0;
  private counter = 0;

  constructor(kind: 'memory' | 'sqlite', overrides: Partial<Config> = {}, items = [item()]) {
    const config = loadConfig(overrides);
    this.store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    const state = initialState('s', config);
    state.domain.items = Object.fromEntries(items.map(value => [value.id, value]));
    state.domain.projectRev = items.length;
    this.store.commit('s', [], {
      seq: 0,
      reducerVersion: REDUCER_VERSION,
      state,
    });
    this.runner = new SessionRunner('s', config, this.store, () => this.at, () => {});
    this.runner.recover('boot');
  }

  get state(): State {
    return this.runner.current();
  }

  send(type: string, payload: object): RunnerResult {
    this.at += 1;
    const event = EventSchema.parse({
      sessionId: 's',
      eventId: `event-${++this.counter}`,
      acceptedAt: this.at,
      type,
      payload,
    });
    const before = this.state;
    const result = this.runner.accept(event);
    for (const invariant of invariantRegistry) {
      expect(invariant(before, event, result.state, result.effects, result.decisions)).toEqual([]);
    }
    this.effects.push(...result.effects);
    expect(this.store.loadSnapshot('s')?.state).toEqual(result.state);
    return result;
  }

  request(questions = ['Does Provider A work offline?'], query = 'Provider A offline', deps = ['r1']): RunnerResult {
    this.send('input.committed', {
      clientMsgId: `message-${this.counter}`,
      text: questions.join(' '),
      modality: 'text',
    });
    const call = this.state.domain.call!;
    return this.send('interpretation.ready', {
      requestId: call.requestId,
      callId: call.callId,
      output: {
        ...readyOutput,
        inputKinds: call.inputIds.map(inputId => ({
          inputId,
          kind: 'direct_question',
        })),
        researchRequests: questions.map(question => ({
          inputId: call.inputIds[0]!,
          question,
          publicQuery: query,
          depItemIds: deps,
        })),
      },
    });
  }

  complete(id = Object.keys(this.state.domain.jobs)[0]!, output = claims, retrieval = evidence): RunnerResult {
    const job = this.state.domain.jobs[id]!;
    return this.send('job.completed', {
      jobId: id,
      callId: job.callId,
      investigatorOutput: output,
      retrievalEvidence: retrieval,
    });
  }

  notices(): string[] {
    return this.effects.flatMap(effect => effect.type === 'client.send'
      && effect.message.type === 'transcript.appended' ? [effect.message.text] : []);
  }
}
