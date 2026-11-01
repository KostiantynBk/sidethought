import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';

async function setup() {
  const config = serverConfig({
    SIDETHOUGHT_PASSCODE: 'test-only-passcode',
    SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
    SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    SIDETHOUGHT_DB_PATH: ':memory:',
    SIDETHOUGHT_MODEL: 'dev',
  });
  const runtime = await createRuntime(config);
  const login = await runtime.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
  const headers = {
    cookie: String(login.headers['set-cookie']).split(';')[0]!,
    origin: config.allowedOrigins[0]!,
  };
  return { runtime, headers };
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === socket.CLOSED) return;
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close();
  await closed;
}

describe('named project socket isolation', () => {
  it('binds inbound events and outbound broadcasts to the socket’s project even in multiple tabs', async () => {
    const { runtime, headers } = await setup();
    const sockets: WebSocket[] = [];
    try {
      const project = runtime.memory.createProject('Independent B');
      const localMessages: Array<Record<string, unknown>> = [];
      const otherMessages: Array<Record<string, unknown>> = [];
      const local = await runtime.app.injectWS('/ws', { headers }, {
        onInit: socket => socket.on('message', data => localMessages.push(JSON.parse(data.toString()))),
      });
      sockets.push(local);
      const other = await runtime.app.injectWS(`/ws?project=${project.id}`, { headers }, {
        onInit: socket => socket.on('message', data => otherMessages.push(JSON.parse(data.toString()))),
      });
      sockets.push(other);
      runtime.broadcast({ type: 'transcript.appended', text: 'only-local-line' });
      runtime.broadcast({ type: 'transcript.appended', text: 'only-B-line' }, project.id);
      await vi.waitFor(() => expect(localMessages.some(message => message.text === 'only-local-line')).toBe(true));
      await vi.waitFor(() => expect(otherMessages.some(message => message.text === 'only-B-line')).toBe(true));
      expect(localMessages.some(message => message.text === 'only-B-line')).toBe(false);
      expect(otherMessages.some(message => message.text === 'only-local-line')).toBe(false);
      local.send(JSON.stringify({
        type: 'input.committed',
        payload: { clientMsgId: 'local-message', text: 'Local private message.', modality: 'text' },
      }));
      await vi.waitFor(() => expect(runtime.runner.current().domain.inputs).toHaveLength(1));
      expect(runtime.projectRunner(project.id).current().domain.inputs).toEqual([]);
      expect(JSON.stringify(otherMessages)).not.toContain('Local private message');
    } finally {
      await Promise.all(sockets.map(closeSocket));
      await runtime.close();
    }
  });

  it('rejects unknown project IDs rather than falling back to the current conversation', async () => {
    const { runtime, headers } = await setup();
    try {
      await expect(runtime.app.injectWS('/ws?project=unknown-project', { headers })).rejects.toThrow();
      await expect(runtime.app.injectWS('/ws?project=..%2Fother', { headers })).rejects.toThrow();
      expect(runtime.memory.projects()).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});
