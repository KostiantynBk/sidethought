export type ActivityState = { active: boolean; idleAt: number | null };

export function typing(now: number): ActivityState {
  return { active: true, idleAt: now + 1500 };
}

export function idle(state: ActivityState, now: number, blurred = false): ActivityState {
  if (blurred || (state.idleAt !== null && now >= state.idleAt)) return { active: false, idleAt: null };
  return state;
}
