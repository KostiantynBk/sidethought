import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';
import { Conversation } from '../web/src/components.js';
import { emptyView, nextView } from '../web/src/logic/view.js';

async function flushSockets() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === socket.CLOSED) return;
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close();
  await closed;
}

it('dev runtime delivers a contribution without another input and restores its label on reconnect', async () => {
  const config = serverConfig({
    SIDETHOUGHT_PASSCODE: 'test-only-passcode',
    SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
    SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    SIDETHOUGHT_DB_PATH: ':memory:',
    SIDETHOUGHT_MODEL: 'dev',
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const runtime = await createRuntime(config);
  const sockets: WebSocket[] = [];
  const messages: Array<Record<string, unknown>> = [];
  try {
    const login = await runtime.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0]!,
      origin: config.allowedOrigins[0]!,
    };
    const socket = await runtime.app.injectWS('/ws', { headers }, {
      onInit: client => client.on('message', data => messages.push(JSON.parse(data.toString()))),
    });
    sockets.push(socket);
    socket.send(JSON.stringify({
      type: 'input.committed',
      payload: {
        clientMsgId: 'synthetic-1',
        text: 'Requirement: Keep offline notes.\nOption: Recover offline notes.',
        modality: 'text',
      },
    }));
    await flushSockets();
    const acknowledged = new Set<string>();
    const chars = new Map<string, number>();
    for (let step = 0; step < 100; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await flushSockets();
      for (const message of messages) {
        if (message.type !== 'assistant.chunk') continue;
        const key = `${message.deliveryId}:${message.chunkIdx}`;
        if (acknowledged.has(key)) continue;
        acknowledged.add(key);
        const id = String(message.deliveryId);
        const count = (chars.get(id) ?? 0) + String(message.text).length;
        chars.set(id, count);
        const done = messages.some(value => value.type === 'assistant.done' && value.deliveryId === id);
        socket.send(JSON.stringify({
          type: 'delivery.progress',
          payload: { deliveryId: id, chunkIdx: message.chunkIdx, chars: count, final: done, reason: 'rendered' },
        }));
      }
      await flushSockets();
    }
    const delivered = messages.find(message => message.type === 'contribution.upserted'
      && message.payload === 'inference' && message.state === 'delivered');
    expect(delivered).toBeDefined();
    expect(runtime.runner.current().domain.inputs).toHaveLength(1);
    const deliveryId = delivered!.deliveryId;
    const announced = messages.findIndex(message => message.type === 'contribution.upserted'
      && message.deliveryId === deliveryId && message.state === 'delivering');
    const chunk = messages.findIndex(message => message.type === 'assistant.chunk'
      && message.deliveryId === deliveryId);
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(chunk).toBeGreaterThan(announced);
    expect(messages.some(message => message.type === 'assistant.done' && message.deliveryId === deliveryId)).toBe(true);
    vi.useRealTimers();
    await closeSocket(socket);
    const reconnected: Array<Record<string, unknown>> = [];
    const socket2 = await runtime.app.injectWS('/ws', { headers }, {
      onInit: client => client.on('message', data => reconnected.push(JSON.parse(data.toString()))),
    });
    sockets.push(socket2);
    await vi.waitFor(() => expect(reconnected.some(message => message.type === 'ui.snapshot')).toBe(true));
    const snapshot = reconnected.find(message => message.type === 'ui.snapshot')!;
    const view = nextView(emptyView(), snapshot as { type: string });
    expect(view.contributions.some(item => item.deliveryId === deliveryId)).toBe(true);
    const html = renderToStaticMarkup(<Conversation view={view} />);
    expect(html).toContain('Sidethought — unprompted');
    expect(html).toContain('reasoning');
  } finally {
    vi.useRealTimers();
    await Promise.all(sockets.map(closeSocket));
    await runtime.close();
  }
});
