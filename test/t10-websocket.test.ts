import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import type { RawEvent } from '../src/runtime/model-port.js';
import type { ServerConfig } from '../src/server/config.js';
import { createGateway } from '../src/server/gateway.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function settings(): ServerConfig {
  const folder = mkdtempSync(join(tmpdir(), 'sidethought-ws-'));
  folders.push(folder);
  return {
    passcode: 'test-only-passcode', cookieSecret: 'test-only-cookie-secret-is-long-enough',
    allowedOrigins: ['http://127.0.0.1:5173'], insecureCookie: false,
    dbPath: join(folder, 'db.sqlite'), port: 3000, model: 'dev',
  };
}

async function setup() {
  const config = settings();
  const events: RawEvent[] = [];
  const gateway = await createGateway(config, () => initialState('local', loadConfig()), event => events.push(event));
  const login = await gateway.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  return { ...gateway, config, events, cookie };
}

describe('WebSocket gateway', () => {
  it('rejects a bad origin', async () => {
    const server = await setup();
    try {
      await expect(server.app.injectWS('/ws', { headers: { origin: 'https://evil.invalid', cookie: server.cookie } }))
        .rejects.toThrow();
    } finally {
      await server.app.close();
    }
  });

  it('rejects a missing cookie', async () => {
    const server = await setup();
    try {
      await expect(server.app.injectWS('/ws', { headers: { origin: server.config.allowedOrigins[0]! } }))
        .rejects.toThrow();
    } finally {
      await server.app.close();
    }
  });

  it('rejects an event outside the allowlist before it reaches the kernel', async () => {
    const server = await setup();
    try {
      const ws = await server.app.injectWS('/ws', {
        headers: { origin: server.config.allowedOrigins[0]!, cookie: server.cookie },
      });
      const closed = new Promise<number>(resolve => ws.on('close', code => resolve(code)));
      ws.send(JSON.stringify({ type: 'reply.done', payload: { requestId: 'r', callId: 'c' } }));
      expect(await closed).toBe(1008);
      expect(server.events.some(event => event.type === 'reply.done')).toBe(false);
    } finally {
      await server.app.close();
    }
  });

  it('rejects an oversized message before it reaches the kernel', async () => {
    const server = await setup();
    try {
      const ws = await server.app.injectWS('/ws', {
        headers: { origin: server.config.allowedOrigins[0]!, cookie: server.cookie },
      });
      const closed = new Promise<number>(resolve => ws.on('close', code => resolve(code)));
      ws.send('x'.repeat(20_000));
      expect(await closed).toBe(1009);
      expect(server.events.some(event => event.type === 'input.committed')).toBe(false);
    } finally {
      await server.app.close();
    }
  });
});
