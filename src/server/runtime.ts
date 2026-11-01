import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import type { ClientMessage } from '../contract/index.js';
import { DevModel } from '../runtime/dev-model.js';
import { DevInvestigator } from '../model/dev-investigator.js';
import { MetaInvestigator, type JobLookup } from '../model/meta/investigator.js';
import { MetaModel } from '../model/meta/executor.js';
import type { ModelExecutor } from '../runtime/model-port.js';
import { SessionRunner } from '../runtime/session-runner.js';
import { SqliteStore } from '../store/sqlite.js';
import type { ServerConfig } from './config.js';
import { createEffectSink } from './effects.js';
import { EventQueue } from './event-queue.js';
import { createGateway } from './gateway.js';
import { TimerScheduler } from './timers.js';

function configuredModel(config: ServerConfig, fetch?: typeof globalThis.fetch): ModelExecutor {
  if (config.model === 'dev') return new DevModel();
  if (!config.meta) throw new Error('Meta model configuration is required');
  return new MetaModel(config.meta.createClient(fetch), config.meta.prices);
}

export async function createRuntime(
  config: ServerConfig,
  injectedModel?: ModelExecutor,
  options: { fetch?: typeof globalThis.fetch; jobLookup?: JobLookup } = {},
) {
  const model = injectedModel ?? configuredModel(config, options.fetch);
  const lookup: JobLookup = options.jobLookup ?? (() => undefined);
  const investigator = config.model === 'meta' && config.meta
    ? new MetaInvestigator(config.meta.createClient(options.fetch), config.meta.prices, lookup)
    : new DevInvestigator(lookup);
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
    investigator,
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
      await investigator.shutdown();
      await gateway.app.close();
      store.close();
    },
  };
}
