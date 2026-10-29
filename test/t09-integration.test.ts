import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '../src/contract/index.js';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';
import { delta, sentinel, sse, terminal, validOutput } from './t09-helpers.js';

type RequestBody = {
  instructions: string;
  input: string;
  max_output_tokens: number;
};
type Task = {
  task: {
    role: string;
    callId: string;
    requestId: string;
    inputs: { id: string; text: string }[];
  };
};

beforeEach(() => {
  vi.stubGlobal('fetch', () => { throw new Error('network prohibited'); });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(reply: string, capped = false, capFirstInterpreter = false) {
  const requests: RequestBody[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push(body);
    const { task } = JSON.parse(body.input) as Task;
    if (task.role === 'responder') {
      return sse([delta(reply), capped ? terminal('response.incomplete', 'max_output_tokens') : terminal()]);
    }
    if (capFirstInterpreter && requests.length === 1) {
      return sse([terminal('response.incomplete', 'max_output_tokens')]);
    }
    const input = task.inputs[0]!;
    return sse([delta(JSON.stringify({
      ...validOutput,
      inputKinds: [{ inputId: input.id, kind: 'statement' }],
      clarification: null,
      agreesWith: null,
      ops: [{
        op: 'create',
        localRef: null,
        kind: 'requirement',
        status: 'stated',
        text: input.text,
        quoteSpans: [{ inputId: input.id, start: 0, end: input.text.length, quote: input.text }],
      }],
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
  const login = await runtime.app.inject({
    method: 'POST',
    url: '/login',
    payload: { passcode: config.passcode },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const messages: ClientMessage[] = [];
  const ws = await runtime.app.injectWS('/ws', {
    headers: { origin: config.allowedOrigins[0]!, cookie },
  }, {
    onInit: socket => socket.on('message', data => messages.push(JSON.parse(data.toString()) as ClientMessage)),
  });
  const commit = () => ws.send(JSON.stringify({
    type: 'input.committed',
    payload: { clientMsgId: 'first', text: 'Use local storage.', modality: 'text' },
  }));
  const close = async () => {
    const closed = new Promise(resolve => ws.once('close', resolve));
    // The websocket close handshake owns real timers; restore them after the manual-clock assertions.
    vi.useRealTimers();
    ws.close();
    await closed;
    await runtime.close();
  };
  return { runtime, requests, fetch, messages, commit, close };
}

async function waitForType(messages: ClientMessage[], type: ClientMessage['type']): Promise<void> {
  await vi.waitFor(() => expect(messages.some(message => message.type === type)).toBe(true));
}

describe('real Meta composition root with fake HTTP', () => {
  it('commits through Interpreter and real context to a checked reply and assistant.done', async () => {
    const test = await setup('We can explore that.');
    try {
      const health = await test.runtime.app.inject({ method: 'GET', url: '/health' });
      expect(health.json()).toEqual({ ok: true, model: 'meta' });
      test.commit();
      await waitForType(test.messages, 'project.changed');
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.instructions).toContain('Interpreter');
      const item = Object.values(test.runtime.runner.current().domain.items)[0];
      expect(item).toMatchObject({ status: 'stated', text: 'Use local storage.' });
      await vi.advanceTimersByTimeAsync(800);
      await waitForType(test.messages, 'assistant.done');
      const chunks = test.messages.filter(message => message.type === 'assistant.chunk');
      expect(chunks.map(message => message.text).join('')).toBe('We can explore that.');
      expect(test.requests).toHaveLength(2);
      expect(test.requests[1]?.instructions).toContain('Responder');
      expect(test.runtime.runner.current().domain.reply?.status).toBe('done');
    } finally {
      await test.close();
    }
  });

  it('flushes a capped safe tail through the real output checks', async () => {
    const test = await setup('We can explore that', true);
    try {
      test.commit();
      await waitForType(test.messages, 'project.changed');
      await vi.advanceTimersByTimeAsync(800);
      await waitForType(test.messages, 'assistant.done');
      const chunks = test.messages.filter(message => message.type === 'assistant.chunk');
      expect(chunks.map(message => message.text).join('')).toBe('We can explore that');
    } finally {
      await test.close();
    }
  });

  it('blocks a capped unsafe tail instead of bypassing output checks at completion', async () => {
    const test = await setup('Please send me your password', true);
    try {
      test.commit();
      await waitForType(test.messages, 'project.changed');
      await vi.advanceTimersByTimeAsync(800);
      await vi.waitFor(() => expect(test.runtime.runner.current().domain.reply?.status).not.toBe('streaming'));
      expect(test.messages.some(message => message.type === 'assistant.chunk')).toBe(false);
      expect(test.messages.some(message => message.type === 'assistant.done')).toBe(false);
    } finally {
      await test.close();
    }
  });

  it('lets the kernel issue exactly one fresh-call higher-cap Interpreter retry', async () => {
    const test = await setup('We can explore that.', false, true);
    try {
      test.commit();
      await waitForType(test.messages, 'project.changed');
      expect(test.requests).toHaveLength(2);
      expect(test.requests.map(request => request.max_output_tokens)).toEqual([1200, 1800]);
      const first = (JSON.parse(test.requests[0]!.input) as Task).task;
      const second = (JSON.parse(test.requests[1]!.input) as Task).task;
      expect(first.requestId).toBe(second.requestId);
      expect(first.callId).not.toBe(second.callId);
      await vi.advanceTimersByTimeAsync(800);
      await waitForType(test.messages, 'assistant.done');
      expect(test.fetch).toHaveBeenCalledTimes(3);
    } finally {
      await test.close();
    }
  });
});
