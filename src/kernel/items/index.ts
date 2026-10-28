import type { Config } from '../../config/index.js';
import { KernelIdSchema, kernelId, type Item, type QuoteSpan } from '../../contract/index.js';
import { normalize, validateSpans, type QuoteInput } from './spans.js';

export { validateSpans } from './spans.js';
export type { QuoteInput } from './spans.js';
export type ItemState = {
  items: Record<string, Item>;
  projectRev: number;
};
type Status = Item['status'];
type Source = 'interpreter' | 'deliberator' | 'user' | 'finding';
export type ItemOp = {
  kind: Item['kind'];
  status: Status;
  text: string;
  quoteSpans: QuoteSpan[];
  origin: 'user' | 'assistant';
  source: Source;
  private: boolean;
  voiceOrigin?: boolean;
};
export type Outcome = {
  state: ItemState;
  decisions: string[];
};
type Action = {
  itemId: string;
  expectedVersion: number;
  action: 'confirm' | 'reject' | 'edit' | 'delete';
  text?: string;
};
function unchanged(state: ItemState, reason: string): Outcome {
  return {
    state,
    decisions: [reason],
  };
}
function replace(state: ItemState, item: Item, reason: string): Outcome {
  return {
    state: {
      items: {
        ...state.items,
        [item.id]: item,
      },
      projectRev: state.projectRev + 1,
    },
    decisions: [reason],
  };
}
function authorize(op: ItemOp, inputs: QuoteInput[], config: Config): { status?: Status; reason: string } {
  if (op.source === 'finding' || op.status === 'confirmed') return { reason: 'authority:denied' };
  if (op.origin === 'assistant') {
    return op.status === 'proposed' && (op.source === 'interpreter' || op.source === 'deliberator')
      ? {
          status: 'proposed',
          reason: 'authority:proposed',
        }
      : { reason: 'authority:denied' };
  }
  if (op.status === 'proposed') {
    return op.source === 'interpreter' || op.source === 'deliberator'
      ? {
          status: 'proposed',
          reason: 'authority:proposed',
        }
      : { reason: 'authority:denied' };
  }
  if (op.source === 'user' && ['superseded', 'retracted', 'rejected'].includes(op.status)) {
    return {
      status: op.status,
      reason: 'authority:user_action',
    };
  }
  if (op.source !== 'interpreter') return { reason: 'authority:denied' };
  const result = validateSpans(op, inputs, config);
  const userSpan = op.quoteSpans.some((span) =>
    inputs.some((input) => input.id === span.inputId && input.origin === 'user'),
  );
  if (!result.allowed || !userSpan) return { reason: result.allowed ? 'authority:user_span_required' : result.reason };
  return {
    status: result.status as Status,
    reason: result.reason,
  };
}
function needsVoiceConfirm(op: ItemOp, inputs: QuoteInput[]): boolean {
  return (
    op.voiceOrigin === true ||
    op.quoteSpans.some((span) =>
      inputs.some((input) => input.id === span.inputId && input.origin === 'user' && input.modality === 'voice'),
    )
  );
}
function isUserQuestion(op: ItemOp, inputs: QuoteInput[], config: Config): boolean {
  const userSpans = op.quoteSpans.filter((span) =>
    inputs.some((input) => input.id === span.inputId && input.origin === 'user'),
  );
  return (
    validateSpans(
      {
        ...op,
        quoteSpans: userSpans,
      },
      inputs,
      config,
    ).reason === 'status:capped:question'
  );
}
function buildItem(id: string, op: ItemOp, status: Status, inputs: QuoteInput[], config: Config, seed?: Item): Item {
  return {
    ...seed,
    id,
    kind: status === 'considering' && isUserQuestion(op, inputs, config) ? 'open_question' : op.kind,
    status,
    text: op.text,
    contentVersion: seed?.contentVersion ?? 1,
    private: op.private,
    provenance: {
      origin: op.origin,
      quoteSpans: op.quoteSpans.map((span) => ({ ...span })),
    },
    voiceConfirmNeeded: seed?.voiceConfirmNeeded === true || needsVoiceConfirm(op, inputs),
  };
}
export function createItem(
  state: ItemState,
  op: ItemOp,
  inputs: QuoteInput[],
  config: Config,
  identity: { sessionId: string; seq: number; n: number },
): Outcome {
  const authority = authorize(op, inputs, config);
  if (!authority.status) return unchanged(state, authority.reason);
  if (!['proposed', 'stated', 'considering'].includes(authority.status)) {
    return unchanged(state, 'authority:invalid_transition');
  }
  const id = kernelId(identity.sessionId, identity.seq, identity.n);
  if (state.items[id]) return unchanged(state, 'item:duplicate');
  const item = buildItem(id, op, authority.status, inputs, config);
  return {
    state: {
      items: {
        ...state.items,
        [item.id]: item,
      },
      projectRev: state.projectRev + 1,
    },
    decisions: [authority.reason],
  };
}
const transitions: Partial<Record<Status, Status[]>> = {
  considering: ['stated', 'retracted'],
  stated: ['superseded', 'retracted'],
  confirmed: ['superseded', 'retracted'],
  proposed: ['rejected'],
};

function statusOp(item: Item, status: Status, source: Source, spans: QuoteSpan[]): ItemOp {
  return {
    kind: item.kind,
    status,
    text: item.text,
    quoteSpans: spans,
    origin: 'user',
    source,
    private: item.private,
  };
}

export function setStatus(
  state: ItemState,
  itemId: string,
  status: Status,
  source: Source,
  spans: QuoteSpan[],
  inputs: QuoteInput[],
  config: Config,
): Outcome {
  const item = state.items[itemId];
  if (!item) return unchanged(state, 'item:not_found');
  const authority = authorize(statusOp(item, status, source, spans), inputs, config);
  if (!authority.status) return unchanged(state, authority.reason);
  if (authority.status === item.status) return unchanged(state, 'noop:unchanged');
  if (!transitions[item.status]?.includes(authority.status)) {
    return unchanged(state, 'authority:invalid_transition');
  }
  return replace(
    state,
    {
      ...item,
      status: authority.status,
      ...(source === 'interpreter'
        ? {
            provenance: {
              origin: 'user' as const,
              quoteSpans: spans.map((span) => ({ ...span })),
            },
          }
        : {}),
    },
    authority.reason,
  );
}
export function updateItem(state: ItemState, itemId: string, text: string, source: Source): Outcome {
  const item = state.items[itemId];
  if (!item) return unchanged(state, 'item:not_found');
  if (source !== 'user') return unchanged(state, 'authority:edit_user_only');
  if (item.text === text) return unchanged(state, 'noop:unchanged');
  return replace(
    state,
    {
      ...item,
      text,
      contentVersion: item.contentVersion + 1,
    },
    'item:edited',
  );
}
export function itemAction(state: ItemState, action: Action): Outcome {
  if (action.action === 'delete') return unchanged(state, 'noop:deferred_T08');
  const item = state.items[action.itemId];
  if (!item) return unchanged(state, 'item:not_found');
  if (item.contentVersion !== action.expectedVersion) return unchanged(state, 'action:stale_version');
  if (action.action === 'edit') return updateItem(state, item.id, action.text ?? item.text, 'user');
  const status = action.action === 'confirm' ? 'confirmed' : 'rejected';
  if (item.status === status) return unchanged(state, 'noop:unchanged');
  const valid = action.action === 'confirm' ? ['proposed', 'stated'].includes(item.status) : item.status === 'proposed';
  if (!valid) return unchanged(state, 'authority:invalid_transition');
  return replace(
    state,
    {
      ...item,
      status,
      voiceConfirmNeeded: action.action === 'confirm' ? false : item.voiceConfirmNeeded,
      verbalConfirmPending: false,
    },
    `action:${action.action}`,
  );
}
export function verbalAgreement(state: ItemState, itemId: string): Outcome {
  const item = state.items[itemId];
  if (!item) return unchanged(state, 'item:not_found');
  if (item.status !== 'proposed' || item.verbalConfirmPending) return unchanged(state, 'noop:unchanged');
  return replace(
    state,
    {
      ...item,
      verbalConfirmPending: true,
    },
    'item:verbal_confirm_pending',
  );
}
function replacementOp(replacement: Item): ItemOp {
  return {
    kind: replacement.kind,
    status: replacement.status,
    text: replacement.text,
    quoteSpans: replacement.provenance.quoteSpans,
    origin: replacement.provenance.origin,
    source: 'interpreter',
    private: replacement.private,
  };
}

export function supersedeItem(
  state: ItemState,
  oldId: string,
  replacement: Item,
  source: Source,
  inputs: QuoteInput[],
  config: Config,
): Outcome {
  const old = state.items[oldId];
  if (!old) return unchanged(state, 'item:not_found');
  if (source !== 'user' && source !== 'interpreter') return unchanged(state, 'authority:denied');
  if (!['stated', 'confirmed'].includes(old.status)) return unchanged(state, 'authority:invalid_transition');
  if (source === 'interpreter') {
    const status = setStatus(state, oldId, 'superseded', source, replacement.provenance.quoteSpans, inputs, config);
    if (status.state === state) return unchanged(state, status.decisions[0] ?? 'authority:denied');
  }
  const op = replacementOp(replacement);
  const checked = authorize(op, inputs, config);
  if (!checked.status || checked.status !== replacement.status) return unchanged(state, 'authority:denied');
  if (!['proposed', 'stated', 'considering'].includes(checked.status)) {
    return unchanged(state, 'authority:invalid_transition');
  }
  if (!KernelIdSchema.safeParse(replacement.id).success) return unchanged(state, 'item:invalid_id');
  if (normalize(old.text) === normalize(replacement.text)) return unchanged(state, 'noop:unchanged');
  if (state.items[replacement.id] !== undefined) return unchanged(state, 'item:duplicate');
  return {
    state: {
      items: {
        ...state.items,
        [oldId]: {
          ...old,
          status: 'superseded',
        },
        [replacement.id]: buildItem(replacement.id, op, checked.status, inputs, config, replacement),
      },
      projectRev: state.projectRev + 1,
    },
    decisions: ['item:superseded'],
  };
}
