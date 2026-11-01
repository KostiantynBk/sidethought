import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) return;
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.close();
  await closed;
}

it('dev runtime recalls a reviewed lesson and delivers it unprompted in a different project', async () => {
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
  try {
    const login = await runtime.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: config.allowedOrigins[0]! };
    const source = runtime.memory.createProject('Memory A');
    const target = runtime.memory.createProject('Memory B');
    const sourceSocket = await runtime.app.injectWS(`/ws?project=${source.id}`, { headers });
    sockets.push(sourceSocket);
    const sourceText = 'The pilot took 43 minutes on this laptop.';
    sourceSocket.send(JSON.stringify({
      type: 'input.committed',
      payload: { clientMsgId: 'source', text: sourceText, modality: 'text' },
    }));
    await flush();
    const input = runtime.memory.inputs(source.id)[0]!;
    const lesson = runtime.memory.createLesson(source.id, {
      sourceInputId: input.id,
      quote: sourceText,
      text: sourceText,
      terms: ['forecasting'],
      confirmed: true,
    });
    runtime.memory.setEnabled(target.id, true);
    const messages: Array<Record<string, unknown>> = [];
    const targetSocket = await runtime.app.injectWS(`/ws?project=${target.id}`, { headers }, {
      onInit: client => client.on('message', data => messages.push(JSON.parse(data.toString()))),
    });
    sockets.push(targetSocket);
    targetSocket.send(JSON.stringify({
      type: 'input.committed',
      payload: {
        clientMsgId: 'target',
        text: 'Requirement: Use forecasting on this laptop.\nOption: Try a forecasting pilot.',
        modality: 'text',
      },
    }));
    await flush();
    const acknowledged = new Set<string>();
    const chars = new Map<string, number>();
    for (let step = 0; step < 100; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      for (const message of messages) {
        if (message.type !== 'assistant.chunk') continue;
        const key = `${message.deliveryId}:${message.chunkIdx}`;
        if (acknowledged.has(key)) continue;
        acknowledged.add(key);
        const id = String(message.deliveryId);
        const count = (chars.get(id) ?? 0) + String(message.text).length;
        chars.set(id, count);
        const done = messages.some(value => value.type === 'assistant.done' && value.deliveryId === id);
        targetSocket.send(JSON.stringify({
          type: 'delivery.progress',
          payload: { deliveryId: id, chunkIdx: message.chunkIdx, chars: count, final: done, reason: 'rendered' },
        }));
      }
      await flush();
    }
    const delivered = messages.find(message => message.type === 'contribution.upserted'
      && message.payload === 'inference' && message.state === 'delivered');
    expect(delivered).toBeDefined();
    expect(delivered?.lessons).toEqual([expect.objectContaining({
      lessonId: lesson.id,
      sourceProjectName: 'Memory A',
    })]);
    expect(messages.some(message => message.type === 'assistant.chunk'
      && message.deliveryId === delivered?.deliveryId
      && String(message.text).includes('In Memory A you found'))).toBe(true);
    expect(runtime.projectRunner(target.id).current().domain.inputs).toHaveLength(1);
    expect(runtime.memory.recentUses(target.id).some(use => use.lessonId === lesson.id)).toBe(true);
  } finally {
    vi.useRealTimers();
    await Promise.all(sockets.map(close));
    await runtime.close();
  }
});
