import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import type { ClientMessage } from '../contract/index.js';
import { DevModel } from '../runtime/dev-model.js';
import type { ModelExecutor } from '../runtime/model-port.js';
import { SessionRunner } from '../runtime/session-runner.js';
import { SqliteStore } from '../store/sqlite.js';
import type { ServerConfig } from './config.js';
import { createEffectSink } from './effects.js';
import { EventQueue } from './event-queue.js';
import { createGateway } from './gateway.js';
import { TimerScheduler } from './timers.js';

export async function createRuntime(config: ServerConfig, model: ModelExecutor = new DevModel()) {
  const store = new SqliteStore(config.dbPath);
  const sessionId = 'local';
  let runner: SessionRunner;
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  const broadcast = (message: ClientMessage) => gateway?.broadcast(message);
  const queue = new EventQueue(() => runner, broadcast);
  const timers = new TimerScheduler(payload => queue.emit({
    eventId: randomUUID(),
    sessionId,
    type: 'timer.fired',
    payload,
  }));
  const sink = createEffectSink({
    runner: () => runner,
    model,
    timers,
    emit: queue.emit,
    broadcast,
  });
  runner = new SessionRunner(sessionId, loadConfig(), store, Date.now, sink);
  gateway = await createGateway(config, () => runner.current(), queue.emit);
  if (store.loadSnapshot(sessionId)) queue.recover(randomUUID());
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
