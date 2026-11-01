import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import type { ClientMessage } from '../contract/index.js';
import { jobForDispatch } from '../kernel/research/index.js';
import { assembleWithLessons } from '../memory/context.js';
import type { ProjectMemoryStore } from '../memory/store.js';
import { MemoryError } from '../memory/types.js';
import { DevInvestigator } from '../model/dev-investigator.js';
import { MetaInvestigator, type InvestigatorExecutor, type JobLookup } from '../model/meta/investigator.js';
import { DevModel } from '../runtime/dev-model.js';
import { MetaModel } from '../model/meta/executor.js';
import type { ModelExecutor } from '../runtime/model-port.js';
import { SessionRunner } from '../runtime/session-runner.js';
import { SqliteStore } from '../store/sqlite.js';
import type { ServerConfig } from './config.js';
import { createEffectSink } from './effects.js';
import { EventQueue } from './event-queue.js';
import { createGateway } from './gateway.js';
import { projectState } from './projection.js';
import { TimerScheduler } from './timers.js';

type ProjectRuntime = {
  runner: SessionRunner;
  queue: EventQueue;
  timers: TimerScheduler;
  investigator: InvestigatorExecutor;
};

function configuredModel(
  config: ServerConfig,
  memory: ProjectMemoryStore,
  fetch?: typeof globalThis.fetch,
): ModelExecutor {
  if (config.model === 'dev') return new DevModel((state, effect) => assembleWithLessons(memory, state, effect));
  if (!config.meta) throw new Error('Meta model configuration is required');
  return new MetaModel(config.meta.createClient(fetch), config.meta.prices, {
    assemble: (state, effect) => assembleWithLessons(memory, state, effect),
  });
}

export async function createRuntime(
  config: ServerConfig,
  injectedModel?: ModelExecutor,
  options: { fetch?: typeof globalThis.fetch; jobLookup?: JobLookup } = {},
) {
  const store = new SqliteStore(config.dbPath);
  const memory = store.projectMemory();
  const model = injectedModel ?? configuredModel(config, memory, options.fetch);
  const lookup: JobLookup = options.jobLookup ?? jobForDispatch;
  const sessions = new Map<string, ProjectRuntime>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  const broadcast = (projectId: string, message: ClientMessage) => gateway?.broadcast(message, projectId);

  function session(projectId: string): ProjectRuntime {
    if (closing) throw new MemoryError(503, 'Server is shutting down');
    memory.project(projectId);
    const existing = sessions.get(projectId);
    if (existing) return existing;
    let runner: SessionRunner;
    const investigator = config.model === 'meta' && config.meta
      ? new MetaInvestigator(config.meta.createClient(options.fetch), config.meta.prices, lookup)
      : new DevInvestigator(lookup);
    const send = (message: ClientMessage) => broadcast(projectId, message);
    const queue = new EventQueue(() => runner, send);
    const timers = new TimerScheduler(payload => queue.emit({
      eventId: randomUUID(),
      sessionId: projectId,
      type: 'timer.fired',
      payload,
    }));
    const sink = createEffectSink({
      runner: () => runner,
      model,
      investigator,
      timers,
      emit: queue.emit,
      broadcast: send,
    });
    runner = new SessionRunner(projectId, loadConfig(), store, Date.now, sink);
    const runtime = { runner, queue, timers, investigator };
    sessions.set(projectId, runtime);
    if (store.loadSnapshot(projectId)) queue.recover(randomUUID());
    return runtime;
  }

  function stopCalls(runtime: ProjectRuntime, state: ReturnType<SessionRunner['current']>): boolean {
    let failed = false;
    const checks = Object.values(state.domain.initiative.candidates).map(candidate => candidate.check);
    for (const call of [state.domain.call, state.domain.reply, state.domain.initiative.deliberation, ...checks]) {
      if (!call) continue;
      try {
        model.handle({ type: 'llm.abort', callId: call.callId }, { state, emit: runtime.queue.emit });
      } catch {
        failed = true;
      }
    }
    for (const job of Object.values(state.domain.jobs)) {
      if (job.state !== 'running' || !job.callId) continue;
      try {
        runtime.investigator.handle({ type: 'job.abort', callId: job.callId }, {
          state,
          emit: runtime.queue.emit,
        });
      } catch {
        failed = true;
      }
    }
    runtime.timers.shutdown();
    return failed;
  }

  function recoverProject(projectId: string, runtime: ProjectRuntime, connected: boolean): void {
    runtime.queue.recover(randomUUID());
    if (connected) runtime.queue.emit({
      eventId: randomUUID(),
      sessionId: projectId,
      type: 'client.connected',
      payload: { modality: 'text' },
    });
    broadcast(projectId, { type: 'ui.snapshot', state: projectState(runtime.runner.current()) });
    broadcast(projectId, {
      type: 'transcript.appended',
      text: 'A shared lesson changed. Affected replies were removed and extracted project state was cleared. '
        + 'Original user messages remain; please resend any interrupted input if needed.',
    });
  }

  function invalidate(projectIds: string[]): void {
    const affected = projectIds.flatMap(projectId => {
      const runtime = sessions.get(projectId);
      return runtime ? [{ projectId, runtime, state: runtime.runner.current(), failed: false }] : [];
    });
    // Fence ALL affected runners first. One failed abort/recovery cannot leave another project writable.
    for (const entry of affected) {
      try {
        entry.runtime.runner.suspendForMemoryChange();
      } catch {
        entry.failed = true;
      }
    }
    for (const entry of affected) {
      try {
        entry.failed = stopCalls(entry.runtime, entry.state) || entry.failed;
      } catch {
        entry.failed = true;
      }
      if (entry.failed) continue;
      try {
        recoverProject(entry.projectId, entry.runtime, entry.state.domain.clientConnected);
      } catch {
        entry.failed = true;
        // Recovery may have committed before a reconnect/broadcast failed: re-fence even then.
        try {
          entry.runtime.runner.suspendForMemoryChange();
        } catch {
          // suspendForMemoryChange sets its fence and clears RAM before attempting any disk read.
        }
      }
    }
    if (affected.some(entry => entry.failed)) {
      throw new MemoryError(503, 'The lesson changed, but project recovery is incomplete. Restart the server.');
    }
  }

  const local = session('local');
  gateway = await createGateway(config, () => local.runner.current(), local.queue.emit, {
    memory,
    invalidate,
    resolveSession: projectId => {
      const runtime = session(projectId);
      return { state: () => runtime.runner.current(), accept: runtime.queue.emit };
    },
  });
  return {
    ...gateway,
    runner: local.runner,
    projectRunner: (projectId: string) => session(projectId).runner,
    memory,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      for (const runtime of sessions.values()) {
        runtime.queue.close();
        runtime.timers.shutdown();
      }
      // Publish the promise before async cleanup runs so overlapping signals share one shutdown.
      closePromise = Promise.resolve().then(async () => {
        await Promise.all([
          model.shutdown(),
          ...Array.from(sessions.values(), runtime => runtime.investigator.shutdown()),
          gateway.app.close(),
        ]);
        memory.close();
        store.close();
      });
      return closePromise;
    },
  };
}
