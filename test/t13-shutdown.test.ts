import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { ModelExecutor, RawEvent } from '../src/runtime/model-port.js';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';
import { closeWebSockets } from '../src/server/socket-shutdown.js';

function config() {
  return serverConfig({
    SIDETHOUGHT_PASSCODE: 'test-only-passcode',
    SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
    SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    SIDETHOUGHT_DB_PATH: ':memory:',
    SIDETHOUGHT_MODEL: 'dev',
  });
}

// Isolated process: a late uncaught WebSocket event must fail THIS child, not the test runner.
// Uses real TCP/WebSockets, synthetic config and a temporary DB; no Meta/API calls.
const childSource = `
  import { serverConfig } from './src/server/config.ts';
  import { createRuntime } from './src/server/runtime.ts';
  const runtime = await createRuntime(serverConfig({
    SIDETHOUGHT_PASSCODE: 'test-only-passcode',
    SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
    SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    SIDETHOUGHT_DB_PATH: process.argv[1],
    SIDETHOUGHT_MODEL: 'dev',
  }));
  const address = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ address });
  process.on('message', message => {
    if (message !== 'stop') return;
    void runtime.close().then(() => {
      if (runtime.app.websocketServer.clients.size !== 0) throw new Error('Sockets remained after close');
      process.disconnect();
    }).catch(error => {
      console.error(error);
      process.exitCode = 1;
      process.disconnect();
    });
  });
`;

describe('runtime shutdown', () => {
  it('exits cleanly with real browser sockets still open in multiple projects', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sidethought-shutdown-'));
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', childSource, join(folder, 'test.sqlite'),
    ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', data => { stderr += data.toString(); });
    const exited = once(child, 'exit');
    const sockets: WebSocket[] = [];
    try {
      const [{ address }] = await once(child, 'message') as [{ address: string }];
      const login = await fetch(`${address}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passcode: 'test-only-passcode' }),
      });
      const headers = {
        cookie: login.headers.get('set-cookie')!.split(';')[0]!,
        origin: 'http://127.0.0.1:5173',
      };
      const response = await fetch(`${address}/api/projects`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Shutdown B' }),
      });
      const { project } = await response.json() as { project: { id: string } };
      for (const suffix of ['', `?project=${project.id}`]) {
        const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws${suffix}`, { headers });
        sockets.push(socket);
        await once(socket, 'open');
      }
      child.send('stop');
      const [code, signal] = await exited;
      expect(stderr).not.toContain('database connection is not open');
      expect(stderr).not.toContain('TypeError');
      expect(code).toBe(0);
      expect(signal).toBeNull();
    } finally {
      for (const socket of sockets) socket.terminate();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      rmSync(folder, { recursive: true, force: true });
    }
  }, 15_000);

  it('terminates a peer that does not finish its closing handshake by the deadline', async () => {
    vi.useFakeTimers();
    try {
      let finished!: () => void;
      const socket = {
        close: vi.fn(),
        terminate: vi.fn(() => finished()),
      };
      const app = { websocketServer: {
        clients: new Set([socket]),
        close: (callback: () => void) => { finished = callback; },
      } } as unknown as FastifyInstance;
      const closing = closeWebSockets.call(app);
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(1001, 'server shutting down');
      expect(socket.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await closing;
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs cleanup once when two stop requests overlap', async () => {
    const shutdown = vi.fn(async () => {});
    const model: ModelExecutor = { handle: vi.fn(), shutdown };
    const runtime = await createRuntime(config(), model);
    await Promise.all([runtime.close(), runtime.close()]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('ignores late model events after shutdown without reopening or using the database', async () => {
    let emit: ((event: RawEvent) => void) | undefined;
    const model: ModelExecutor = {
      handle: (_effect, context) => { emit = context.emit; },
      shutdown: async () => {},
    };
    const runtime = await createRuntime(config(), model);
    runtime.runner.accept({
      eventId: 'before-shutdown',
      sessionId: 'local',
      type: 'input.committed',
      payload: { clientMsgId: 'one', text: 'Use local storage.', modality: 'text' },
    });
    expect(emit).toBeTypeOf('function');
    await runtime.close();
    expect(() => emit!({
      eventId: 'late-model-callback',
      sessionId: 'local',
      type: 'client.disconnected',
      payload: {},
    })).not.toThrow();
  });
});
