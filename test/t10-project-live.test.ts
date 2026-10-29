import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { ClientMessageSchema, type ClientMessage } from '../src/contract/index.js';
import type { ModelEffect, ModelExecutor, RawEvent } from '../src/runtime/model-port.js';
import type { State } from '../src/kernel/index.js';
import type { ServerConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';
import { projectState } from '../src/server/projection.js';

class QuoteModel implements ModelExecutor {
  handle(effect: ModelEffect, ctx: { state: State; emit: (event: RawEvent) => void }): void {
    if (effect.type !== 'llm.call' || effect.role !== 'interpreter') return;
    const inputId = ctx.state.domain.call?.inputIds[0];
    const input = ctx.state.domain.inputs.find(item => item.id === inputId);
    if (!input) throw new Error('missing scripted input');
    ctx.emit({
      eventId: randomUUID(),
      sessionId: ctx.state.sessionId,
      type: 'interpretation.ready',
      payload: {
        requestId: effect.requestId,
        callId: effect.callId,
        output: {
          inputKinds: [{
            inputId: input.id,
            kind: 'statement',
          }],
          ops: [{
            op: 'create',
            kind: 'requirement',
            status: 'stated',
            text: input.text,
            quoteSpans: [{
              inputId: input.id,
              start: 0,
              end: input.text.length,
              quote: input.text,
            }],
          }],
          replacementGroups: [],
          researchRequests: [],
          deprioritizedTopics: [],
          voiceConfirmValues: [],
        },
      },
    });
  }

  async shutdown(): Promise<void> {}
}

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'sidethought-project-'));
  folders.push(folder);
  const config: ServerConfig = {
    passcode: 'test-only-passcode',
    cookieSecret: 'test-only-cookie-secret-is-long-enough',
    allowedOrigins: ['http://127.0.0.1:5173'],
    insecureCookie: false,
    dbPath: join(folder, 'db.sqlite'),
    port: 3000,
    model: 'dev',
  };
  const runtime = await createRuntime(config, new QuoteModel());
  const login = await runtime.app.inject({
    method: 'POST',
    url: '/login',
    payload: { passcode: config.passcode },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const messages: unknown[] = [];
  const ws = await runtime.app.injectWS('/ws', {
    headers: {
      origin: config.allowedOrigins[0]!,
      cookie,
    },
  }, {
    onInit: socket => socket.on('message', data => messages.push(JSON.parse(data.toString()))),
  });
  return { runtime, ws, messages };
}

type ProjectChanged = Extract<ClientMessage, { type: 'project.changed' }>;

function waitForProject(messages: unknown[], revision: number): Promise<ProjectChanged> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + 5000;
    function check() {
      for (const raw of messages) {
        const value = raw as { type?: string };
        if (value.type !== 'project.changed') continue;
        const parsed = ClientMessageSchema.parse(raw);
        if (parsed.type === 'project.changed' && parsed.projectRev === revision) return resolve(parsed);
      }
      if (Date.now() >= end) return reject(new Error('timed out waiting for project update'));
      setTimeout(check, 20);
    }
    check();
  });
}

async function close(ws: WebSocket, runtime: Awaited<ReturnType<typeof createRuntime>>) {
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.close();
  await closed;
  await runtime.close();
}

function commit(ws: WebSocket): void {
  ws.send(JSON.stringify({
    type: 'input.committed',
    payload: {
      clientMsgId: 'message-one',
      text: 'Use local storage.',
      modality: 'text',
    },
  }));
}

describe('live project projection', () => {
  it('broadcasts a valid quote-backed item after interpretation without reconnecting', async () => {
    const { runtime, ws, messages } = await setup();
    try {
      commit(ws);
      const changed = await waitForProject(messages, 1);
      expect(changed.items).toHaveLength(1);
      expect(changed.items).toEqual(projectState(runtime.runner.current()).items);
      expect(changed.items[0]).toMatchObject({
        kind: 'requirement',
        status: 'stated',
        text: 'Use local storage.',
        provenance: { quoteSpans: [{ quote: 'Use local storage.' }] },
      });
    } finally {
      await close(ws, runtime);
    }
  });

  it('broadcasts an item confirmation without reconnecting', async () => {
    const { runtime, ws, messages } = await setup();
    try {
      commit(ws);
      const created = await waitForProject(messages, 1);
      const item = created.items[0]!;
      ws.send(JSON.stringify({
        type: 'item.action',
        payload: {
          itemId: item.id,
          expectedVersion: item.contentVersion,
          action: 'confirm',
        },
      }));
      const changed = await waitForProject(messages, 2);
      expect(changed.items).toEqual(projectState(runtime.runner.current()).items);
      expect(changed.items[0]?.status).toBe('confirmed');
    } finally {
      await close(ws, runtime);
    }
  });
});
