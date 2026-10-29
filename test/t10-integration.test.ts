import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { ServerConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Message = { type: string; deliveryId?: string; chunkIdx?: number };
function waitFor(messages: Message[], predicate: (message: Message) => boolean, timeout = 5000): Promise<Message> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const found = messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started >= timeout) return reject(new Error('timed out waiting for message'));
      setTimeout(check, 20);
    };
    check();
  });
}

function send(ws: WebSocket, type: string, payload: unknown): void {
  ws.send(JSON.stringify({ type, payload }));
}

async function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'sidethought-integration-'));
  folders.push(folder);
  const config: ServerConfig = {
    passcode: 'test-only-passcode', cookieSecret: 'test-only-cookie-secret-is-long-enough',
    allowedOrigins: ['http://127.0.0.1:5173'], insecureCookie: false,
    dbPath: join(folder, 'db.sqlite'), port: 3000, model: 'dev',
  };
  const runtime = await createRuntime(config);
  const login = await runtime.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const messages: Message[] = [];
  const ws = await runtime.app.injectWS('/ws', { headers: { origin: config.allowedOrigins[0]!, cookie } }, {
    onInit: socket => socket.on('message', data => messages.push(JSON.parse(data.toString()) as Message)),
  });
  return { runtime, ws, messages };
}

async function close(ws: WebSocket, runtime: Awaited<ReturnType<typeof createRuntime>>) {
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.close();
  await closed;
  await runtime.close();
}

describe('dev-model vertical slice', () => {
  it('streams in order then immediately stops the old delivery on another commit', async () => {
    const { runtime, ws, messages } = await setup();
    try {
      await waitFor(messages, message => message.type === 'ui.snapshot');
      send(ws, 'input.committed', { clientMsgId: 'first', text: 'Hello', modality: 'text' });
      const first = await waitFor(messages, message => message.type === 'assistant.chunk');
      send(ws, 'input.committed', { clientMsgId: 'second', text: 'Interrupt', modality: 'text', renderedUpTo: 0 });
      await waitFor(messages, message =>
        message.type === 'assistant.stopped' && message.deliveryId === first.deliveryId);
      const isOldChunk = (message: Message) =>
        message.type === 'assistant.chunk' && message.deliveryId === first.deliveryId;
      const count = messages.filter(isOldChunk).length;
      await new Promise(resolve => setTimeout(resolve, 800));
      const oldChunks = messages.filter(isOldChunk);
      expect(oldChunks).toHaveLength(count);
      expect(oldChunks.map(message => message.chunkIdx)).toEqual(oldChunks.map((_, index) => index));
    } finally {
      await close(ws, runtime);
    }
  }, 10000);

  it('does not start a reply while composer activity is active', async () => {
    const { runtime, ws, messages } = await setup();
    try {
      await waitFor(messages, message => message.type === 'ui.snapshot');
      send(ws, 'input.committed', { clientMsgId: 'first', text: 'Hello', modality: 'text' });
      send(ws, 'input.activity', { channel: 'composer', active: true });
      await new Promise(resolve => setTimeout(resolve, 1300));
      expect(messages.some(message => message.type === 'assistant.chunk')).toBe(false);
      send(ws, 'input.activity', { channel: 'composer', active: false });
      await waitFor(messages, message => message.type === 'assistant.chunk');
    } finally {
      await close(ws, runtime);
    }
  }, 10000);
});
