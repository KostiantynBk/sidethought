import { describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';
import { delta, sentinel, sse, terminal, validOutput } from './t09-helpers.js';

describe('failed input recovery through authenticated UI ports', () => {
  it('reports failed interpretation and explicitly retries the same input through its project socket', async () => {
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const { task } = JSON.parse(JSON.parse(String(init?.body)).input);
      if (task.role === 'responder') return sse([delta('A simple reply.'), terminal()]);
      calls += 1;
      if (calls <= 2) return sse([terminal('response.incomplete', 'max_output_tokens')]);
      return sse([delta(JSON.stringify({
        ...validOutput,
        inputKinds: task.inputs.map((input: { id: string }) => ({ inputId: input.id, kind: 'statement' })),
      })), terminal()]);
    });
    const config = serverConfig({
      SIDETHOUGHT_PASSCODE: 'test-only-passcode',
      SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
      SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      SIDETHOUGHT_DB_PATH: ':memory:',
      SIDETHOUGHT_MODEL: 'meta',
      MODEL_API_KEY: sentinel,
    });
    const runtime = await createRuntime(config, undefined, { fetch });
    const login = await runtime.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0]!,
      origin: config.allowedOrigins[0]!,
    };
    const socket = await runtime.app.injectWS('/ws', { headers });
    try {
      socket.send(JSON.stringify({
        type: 'input.committed',
        payload: { clientMsgId: 'one-message', text: 'Use local storage.', modality: 'text' },
      }));
      await vi.waitFor(() => expect(runtime.runner.current().domain.inputs[0]?.status).toBe('needs_retry'));
      const status = await runtime.app.inject({ method: 'GET', url: '/api/projects/local/input-status', headers });
      const failed = status.json();
      expect(failed.failedCount).toBe(1);
      expect(failed.needsRetry[0].preview).toBe('Use local storage.');
      expect(calls).toBe(2);
      socket.send(JSON.stringify({ type: 'input.retry', payload: { inputIds: [failed.needsRetry[0].id] } }));
      await vi.waitFor(() => expect(runtime.runner.current().domain.inputs[0]?.status).toBe('interpreted'));
      const recovered = await runtime.app.inject({ method: 'GET', url: '/api/projects/local/input-status', headers });
      expect(recovered.json().failedCount).toBe(0);
      expect(runtime.runner.current().domain.inputs).toHaveLength(1);
      expect(calls).toBe(3);
    } finally {
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.close();
      await closed;
      await runtime.close();
    }
  });
});
