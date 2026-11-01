import type { ClientMessage, Effect } from '../contract/index.js';
import type { InvestigatorExecutor } from '../model/meta/investigator.js';
import type { ModelExecutor, RawEvent } from '../runtime/model-port.js';
import type { SessionRunner } from '../runtime/session-runner.js';
import type { TimerScheduler } from './timers.js';

type EffectPorts = {
  runner: () => SessionRunner;
  model: ModelExecutor;
  investigator?: InvestigatorExecutor;
  timers: TimerScheduler;
  emit: (event: RawEvent) => void;
  broadcast: (message: ClientMessage) => void;
};

export function createEffectSink(ports: EffectPorts): (effects: Effect[]) => void {
  return effects => {
    for (const effect of effects) {
      if (effect.type === 'client.send') {
        ports.broadcast(effect.message);
      } else if (effect.type === 'timer.set' || effect.type === 'timer.clear') {
        ports.timers.handle(effect);
      } else if (effect.type === 'llm.call' || effect.type === 'llm.abort') {
        ports.model.handle(effect, {
          state: ports.runner().current(),
          emit: ports.emit,
        });
      } else if (effect.type === 'job.dispatch' || effect.type === 'job.abort') {
        ports.investigator?.handle(effect, {
          state: ports.runner().current(),
          emit: ports.emit,
        });
      }
    }
  };
}
