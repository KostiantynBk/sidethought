import { describe, expect, it } from 'vitest';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';

const env = {
  SIDETHOUGHT_PASSCODE: 'test-only-passcode',
  SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
  SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  SIDETHOUGHT_DB_PATH: ':memory:',
  SIDETHOUGHT_MODEL: 'dev',
};

describe('instance banner', () => {
  it('trims text, ignores blank text and rejects more than 300 characters', () => {
    expect(serverConfig({ ...env, SIDETHOUGHT_BANNER: '  Hello judges  ' }).banner).toBe('Hello judges');
    expect(serverConfig({ ...env, SIDETHOUGHT_BANNER: '   ' }).banner).toBeUndefined();
    expect(serverConfig({ ...env, SIDETHOUGHT_BANNER: 'a'.repeat(300) }).banner).toHaveLength(300);
    expect(() => serverConfig({ ...env, SIDETHOUGHT_BANNER: 'a'.repeat(301) })).toThrow('SIDETHOUGHT_BANNER');
  });

  it.each([undefined, 'Shared workspace'])('only includes a set banner in projects: %s', async banner => {
    const config = serverConfig({ ...env, SIDETHOUGHT_BANNER: banner });
    const runtime = await createRuntime(config);
    try {
      const login = await runtime.app.inject({
        method: 'POST', url: '/login', payload: { passcode: env.SIDETHOUGHT_PASSCODE },
      });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const response = await runtime.app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      if (banner) expect(body.banner).toBe(banner);
      else expect(body).not.toHaveProperty('banner');
    } finally {
      await runtime.close();
    }
  });
});
