import type { Effect } from '../contract/index.js';

type TimerEffect = Extract<Effect, { type: 'timer.set' | 'timer.clear' }>;
type TimerFired = { purpose: Extract<Effect, { type: 'timer.set' }>['purpose']; timerId: string };

export class TimerScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly emit: (event: TimerFired) => void, private readonly now = Date.now) {}

  handle(effect: TimerEffect): void {
    this.clear(effect.timerId);
    if (effect.type === 'timer.clear') return;
    const delay = Math.max(0, effect.dueAt - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(effect.timerId);
      if (effect.dueAt > this.now()) {
        this.handle(effect);
        return;
      }
      this.emit({ purpose: effect.purpose, timerId: effect.timerId });
    }, Math.min(delay, 2_147_483_647));
    this.timers.set(effect.timerId, timer);
  }

  clear(timerId: string): void {
    const timer = this.timers.get(timerId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(timerId);
  }

  shutdown(): void {
    for (const timerId of this.timers.keys()) this.clear(timerId);
  }
}
