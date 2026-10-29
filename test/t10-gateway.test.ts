import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { initialState } from '../src/kernel/index.js';
import { createGateway } from '../src/server/gateway.js';
import type { ServerConfig } from '../src/server/config.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function config(): ServerConfig {
  const folder = mkdtempSync(join(tmpdir(), 'sidethought-t10-'));
  folders.push(folder);
  return {
    passcode: 'test-only-passcode',
    cookieSecret: 'test-only-cookie-secret-is-long-enough',
    allowedOrigins: ['http://127.0.0.1:3000'],
    insecureCookie: false,
    dbPath: join(folder, 'db.sqlite'),
    port: 3000,
    model: 'dev',
  };
}

async function gateway(settings: ServerConfig) {
  return createGateway(settings, () => initialState('local', loadConfig()), () => {});
}

describe('login gateway', () => {
  it('sets a signed secure HttpOnly Strict cookie for the correct passcode', async () => {
    const settings = config();
    const server = await gateway(settings);
    try {
      const response = await server.app.inject({ method: 'POST', url: '/login', payload: { passcode: settings.passcode } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toMatch(/HttpOnly/);
      expect(response.headers['set-cookie']).toMatch(/Secure/);
      expect(response.headers['set-cookie']).toMatch(/SameSite=Strict/);
    } finally {
      await server.app.close();
    }
  });

  it('relaxes Secure only for explicitly enabled local HTTP', async () => {
    const settings = { ...config(), insecureCookie: true };
    const server = await gateway(settings);
    try {
      const response = await server.app.inject({
        method: 'POST', url: '/login', headers: { host: '127.0.0.1:5173' },
        payload: { passcode: settings.passcode },
      });
      expect(response.headers['set-cookie']).not.toMatch(/Secure/);
      const remote = await server.app.inject({
        method: 'POST', url: '/login', headers: { host: 'example.ts.net' },
        payload: { passcode: settings.passcode },
      });
      expect(remote.headers['set-cookie']).toMatch(/Secure/);
    } finally {
      await server.app.close();
    }
  });

  it('rejects a wrong passcode', async () => {
    const server = await gateway(config());
    try {
      const response = await server.app.inject({ method: 'POST', url: '/login', payload: { passcode: 'wrong' } });
      expect(response.statusCode).toBe(401);
    } finally {
      await server.app.close();
    }
  });

  it('preserves login lockout across gateway restart', async () => {
    const settings = config();
    const first = await gateway(settings);
    for (let i = 0; i < 5; i++) {
      const response = await first.app.inject({ method: 'POST', url: '/login', payload: { passcode: 'wrong' } });
      expect(response.statusCode).toBe(401);
    }
    await first.app.close();
    const second = await gateway(settings);
    try {
      const response = await second.app.inject({ method: 'POST', url: '/login', payload: { passcode: settings.passcode } });
      expect(response.statusCode).toBe(429);
    } finally {
      await second.app.close();
    }
  });
});
