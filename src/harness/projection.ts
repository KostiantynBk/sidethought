import type { State } from '../kernel/index.js';
import type { Fixture } from './schema.js';

function projectedDeliveries(state: State, fixture: Fixture) {
  return Object.fromEntries(Object.entries(state.domain.deliveries).map(([id, delivery]) => {
    // Older fixture expectations omit the optional settlement flag; targeted tests assert it.
    if (fixture.expected.final.deliveries?.[id]?.settled !== undefined) return [id, delivery];
    const { settled: _settled, ...rest } = delivery;
    return [id, rest];
  }));
}

function projectedCall(call: State['domain']['call']) {
  if (!call) return null;
  // Fixture call projections assert the established identity fields; witness races have dedicated tests.
  return {
    requestId: call.requestId,
    callId: call.callId,
    attempt: call.attempt,
    inputIds: call.inputIds,
    basisRev: call.basisRev,
    capturedInputs: call.capturedInputs,
  };
}

export function finalProjection(state: State, fixture: Fixture) {
  return {
    seq: state.meta.seq,
    pendingTimers: state.domain.timers,
    inFlight: projectedCall(state.domain.call),
    uninterpreted: state.domain.inputs.filter(input => input.status !== 'interpreted')
      .map(({ floorEpoch: _floorEpoch, ...input }) => input),
    reservations: state.domain.reservations,
    replyPending: state.domain.replyPending,
    ...(fixture.expected.final.reply !== undefined ? { reply: state.domain.reply } : {}),
    ...(fixture.expected.final.deliveries !== undefined ? { deliveries: projectedDeliveries(state, fixture) } : {}),
    ...(fixture.expected.final.replyStartWaiting !== undefined
      ? { replyStartWaiting: state.domain.replyStartWaiting } : {}),
    ...(fixture.expected.final.project ? {
      project: {
        items: Object.values(state.domain.items).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        projectRev: state.domain.projectRev,
      },
    } : {}),
  };
}
