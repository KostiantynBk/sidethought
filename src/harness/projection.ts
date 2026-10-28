import type { State } from '../kernel/index.js';
import type { Fixture } from './schema.js';

export function finalProjection(state: State, fixture: Fixture) {
  return {
    seq: state.meta.seq,
    pendingTimers: state.domain.timers,
    inFlight: state.domain.call,
    uninterpreted: state.domain.inputs.filter(input => input.status !== 'interpreted')
      .map(({ floorEpoch: _floorEpoch, ...input }) => input),
    reservations: state.domain.reservations,
    replyPending: state.domain.replyPending,
    ...(fixture.expected.final.reply !== undefined ? { reply: state.domain.reply } : {}),
    ...(fixture.expected.final.deliveries !== undefined ? { deliveries: state.domain.deliveries } : {}),
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
