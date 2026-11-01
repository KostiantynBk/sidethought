import type { Candidate, Dep, Delivery } from '../../contract/index.js';

export type Contribution = Candidate & {
  class: 'speak' | 'card';
  state: Delivery['state'];
  topic: string;
  text: string;
  createdAt: number;
  jobId?: string;
  deliveryId?: string;
  check?: RoleCall & { inputCount: number; deadlineTimerId: string };
  rechecks: number;
  checkedInputCount?: number;
  checkCallId?: string;
  checkedClaims?: string[];
  utterance?: string;
};

export type RoleCall = {
  requestId: string;
  callId: string;
  basisRev: number;
  capturedInputs: Dep[];
};

export type Trigger = {
  inputIds: string[];
  causalDepth: number;
};

export type Initiative = {
  candidates: Record<string, Contribution>;
  deliberation: (RoleCall & Trigger & { deadlineTimerId: string; deadlineAt: number }) | null;
  trigger: Trigger | null;
  runsPerInput: Record<string, number>;
  runTimes: number[];
  dismissedTopics: string[];
  askedTopics: string[];
  scopeEnabled: boolean;
  lastSpeakAt: number | null;
};

export function emptyInitiative(): Initiative {
  return {
    candidates: {},
    deliberation: null,
    trigger: null,
    runsPerInput: {},
    runTimes: [],
    dismissedTopics: [],
    askedTopics: [],
    scopeEnabled: true,
    lastSpeakAt: null,
  };
}
