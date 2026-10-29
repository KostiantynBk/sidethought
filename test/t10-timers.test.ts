import { describe, expect, it, vi } from 'vitest';
import { TimerScheduler } from '../src/server/timers.js';

describe('timer scheduler', () => {
  it('emits at the due time', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const emit = vi.fn();
      const timers = new TimerScheduler(emit);
      timers.handle({ type: 'timer.set', timerId: 'timer', purpose: 'replyDebounce', dueAt: 1500 });
      vi.advanceTimersByTime(499);
      expect(emit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(emit).toHaveBeenCalledWith({ timerId: 'timer', purpose: 'replyDebounce' });
      timers.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit a cleared timer', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const emit = vi.fn();
      const timers = new TimerScheduler(emit);
      timers.handle({ type: 'timer.set', timerId: 'timer', purpose: 'replyDebounce', dueAt: 1500 });
      timers.handle({ type: 'timer.clear', timerId: 'timer' });
      vi.advanceTimersByTime(500);
      expect(emit).not.toHaveBeenCalled();
      timers.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
