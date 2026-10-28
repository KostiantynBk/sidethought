import type { Delivery, Effect, Item, Dep, InterpreterOutput, ReplyGeneration } from '../contract/index.js';
import type { Config } from '../config/index.js';

export type Decision = {
  seq: number;
  kind: string;
  reason: string;
};
type Input = {
  id: string;
  text: string;
  status: 'waiting' | 'inflight' | 'interpreted' | 'needs_retry';
  origin?: 'user' | 'assistant';
  modality?: 'text' | 'voice';
  kind?: InterpreterOutput['inputKinds'][number]['kind'];
  conflicts?: number;
  floorEpoch?: number;
};
export type Call = {
  requestId: string;
  callId: string;
  attempt: number;
  inputIds: string[];
  basisRev: number;
  capturedInputs: Dep[];
};
export type Timer = {
  timerId: string;
  purpose: Extract<Effect, { type: 'timer.set' }>['purpose'];
  dueAt: number;
};
export type State = {
  sessionId: string;
  config: Config;
  meta: {
    seq: number;
    eventIds: string[];
    clientMsgIds: string[];
  };
  domain: {
    sessionEpoch: number;
    researchEpoch: number;
    projectRev: number;
    items: Record<string, Item>;
    inputs: Input[];
    call: Call | null;
    timers: Timer[];
    replyPending: boolean;
    replyStartWaiting: boolean;
    reply: ReplyGeneration | null;
    deliveries: Record<string, Delivery>;
    awaitingUserAnswer: boolean;
    userWait: boolean;
    clientConnected: boolean;
    lastFloorActivity: number | null;
    floorEpoch: number;
    interruptedCalls: (Call & { status: 'interrupted' })[];
    reservations: string[];
    pendingRequests: Array<{
      inputId: string;
      question: string;
      publicQuery: string;
      depItemIds: string[];
      deps: Dep[];
      promised: true;
    }>;
    clarifications: Array<{
      inputIds: string[];
      clarification: string | undefined;
    }>;
  };
};
export type Result = {
  state: State;
  effects: Effect[];
  decisions: Decision[];
};
export type Context = {
  domain: State['domain'];
  effects: Effect[];
  itemDecisions: string[];
  id: () => string;
};

export function initialState(sessionId: string, config: Config): State {
  return {
    sessionId,
    config,
    meta: {
      seq: 0,
      eventIds: [],
      clientMsgIds: [],
    },
    domain: {
      sessionEpoch: 0,
      researchEpoch: 0,
      projectRev: 0,
      items: {},
      inputs: [],
      call: null,
      timers: [],
      replyPending: false,
      replyStartWaiting: false,
      reply: null,
      deliveries: {},
      awaitingUserAnswer: false,
      userWait: false,
      clientConnected: false,
      lastFloorActivity: null,
      floorEpoch: 0,
      interruptedCalls: [],
      reservations: [],
      pendingRequests: [],
      clarifications: [],
    },
  };
}

