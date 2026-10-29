import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import type { Effect } from '../contract/index.js';
import { DevModel } from '../runtime/dev-model.js';
import type { RawEvent } from '../runtime/model-port.js';
import { SessionRunner } from '../runtime/session-runner.js';
import { SqliteStore } from '../store/sqlite.js';
import type { ServerConfig } from './config.js';
import { createGateway } from './gateway.js';
import { TimerScheduler } from './timers.js';

export async function createRuntime(config: ServerConfig) {
  const store = new SqliteStore(config.dbPath);
  const model = new DevModel();
  const sessionId = 'local';
  const queue: RawEvent[] = [];
  let draining = false;
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  const emit = (event: RawEvent) => {
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      while (queue.length) runner.accept(queue.shift()!);
    } finally {
      draining = false;
    }
  };
  const timers = new TimerScheduler(payload => emit({
    eventId: randomUUID(), sessionId, type: 'timer.fired', payload,
  }));
  const sink = (effects: Effect[]) => {
    for (const effect of effects) {
      if (effect.type === 'client.send') gateway?.broadcast(effect.message);
      else if (effect.type === 'timer.set' || effect.type === 'timer.clear') timers.handle(effect);
      else if (effect.type === 'llm.call' || effect.type === 'llm.abort') {
        model.handle(effect, { state: runner.current(), emit });
      } else if (effect.type.startsWith('job.')) console.log('unsupported job effect');
    }
  };
  const runner = new SessionRunner(sessionId, loadConfig(), store, Date.now, sink);
  gateway = await createGateway(config, () => runner.current(), emit);
  if (store.loadSnapshot(sessionId)) {
    // Recovery is itself an accept, so queue any effects it emits until it returns.
    draining = true;
    try {
      runner.recover(randomUUID());
    } finally {
      draining = false;
    }
    while (queue.length) emit(queue.shift()!);
  }
  return {
    ...gateway,
    runner,
    async close() {
      timers.shutdown();
      await model.shutdown();
      await gateway.app.close();
      store.close();
    },
  };
}
